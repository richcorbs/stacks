// speech_helper.m — ObjC helper for speech recognition with block-based APIs
//
// Provides C-callable functions that wrap the block-based Speech framework APIs,
// allowing Zig code to use speech recognition without directly creating ObjC blocks.

#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>

// Callback function type for transcription results
typedef void (*TranscriptionCallback)(const char *text, int isFinal, void *context);

// Global state (single instance)
static SFSpeechRecognizer *speechRecognizer = nil;
static AVAudioEngine *audioEngine = nil;
static SFSpeechAudioBufferRecognitionRequest *recognitionRequest = nil;
static SFSpeechRecognitionTask *recognitionTask = nil;
static TranscriptionCallback transcriptionCallback = NULL;
static void *callbackContext = NULL;

// Initialize speech recognizer and request permissions.
// Audio engine is created fresh per session in speech_start().
int speech_init(void) {
    if (speechRecognizer != nil) return 1;
    
    // Request microphone permission
    if (@available(macOS 10.14, *)) {
        AVAuthorizationStatus micStatus = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
        if (micStatus == AVAuthorizationStatusNotDetermined) {
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
                dispatch_semaphore_signal(sem);
            }];
            dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        } else if (micStatus == AVAuthorizationStatusDenied) {
            return 0;
        }
    }
    
    // Request speech recognition permission
    SFSpeechRecognizerAuthorizationStatus status = [SFSpeechRecognizer authorizationStatus];
    if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block BOOL authorized = NO;
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            authorized = (status == SFSpeechRecognizerAuthorizationStatusAuthorized);
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        if (!authorized) return 0;
    }
    
    speechRecognizer = [[SFSpeechRecognizer alloc] init];
    if (!speechRecognizer || !speechRecognizer.isAvailable) return 0;
    
    return 1;
}

// Start listening with the given callback.
// Creates a fresh audio engine each time so we pick up any input device changes.
int speech_start(TranscriptionCallback callback, void *context) {
    if (!speechRecognizer) {
        if (!speech_init()) return 0;
    }
    
    // Cancel any existing task
    if (recognitionTask) {
        [recognitionTask cancel];
        recognitionTask = nil;
    }
    
    transcriptionCallback = callback;
    callbackContext = context;
    
    // Fresh audio engine each session — picks up current system default input
    audioEngine = [[AVAudioEngine alloc] init];
    
    // Create recognition request
    recognitionRequest = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    recognitionRequest.shouldReportPartialResults = YES;
    if (speechRecognizer.supportsOnDeviceRecognition) {
        recognitionRequest.requiresOnDeviceRecognition = YES;
    }
    
    // Capture audio from system default input
    AVAudioInputNode *inputNode = audioEngine.inputNode;
    AVAudioFormat *format = [inputNode outputFormatForBus:0];
    
    [inputNode installTapOnBus:0
                    bufferSize:1024
                        format:format
                         block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        [recognitionRequest appendAudioPCMBuffer:buffer];
    }];
    
    NSError *error = nil;
    [audioEngine prepare];
    if (![audioEngine startAndReturnError:&error]) {
        NSLog(@"Audio engine failed to start: %@", error);
        return 0;
    }
    
    // Start recognition
    recognitionTask = [speechRecognizer recognitionTaskWithRequest:recognitionRequest
                                                    resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        if (result && transcriptionCallback) {
            NSString *text = result.bestTranscription.formattedString;
            transcriptionCallback([text UTF8String], result.isFinal, callbackContext);
        }
    }];
    
    return 1;
}

// Stop listening. Calls endAudio first to let the recognizer finish processing,
// then finishes (not cancels) the task to get the final transcription.
void speech_stop(void) {
    if (audioEngine && audioEngine.isRunning) {
        [audioEngine stop];
        [audioEngine.inputNode removeTapOnBus:0];
    }
    audioEngine = nil;
    
    if (recognitionRequest) {
        [recognitionRequest endAudio];
        recognitionRequest = nil;
    }
    
    if (recognitionTask) {
        [recognitionTask finish];
        recognitionTask = nil;
    }
    
    transcriptionCallback = NULL;
    callbackContext = NULL;
}

// Check if currently listening
int speech_is_listening(void) {
    return audioEngine != nil && audioEngine.isRunning;
}

// Get the current system default input device name
const char* speech_get_input_device_name(void) {
    static char deviceName[256] = "Unknown";
    
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    
    AudioDeviceID deviceID = 0;
    UInt32 size = sizeof(deviceID);
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &deviceID);
    
    if (status == noErr) {
        address.mSelector = kAudioDevicePropertyDeviceNameCFString;
        CFStringRef name = NULL;
        size = sizeof(name);
        status = AudioObjectGetPropertyData(deviceID, &address, 0, NULL, &size, &name);
        if (status == noErr && name) {
            CFStringGetCString(name, deviceName, sizeof(deviceName), kCFStringEncodingUTF8);
            CFRelease(name);
        }
    }
    
    return deviceName;
}

// Clean up everything
void speech_cleanup(void) {
    speech_stop();
    speechRecognizer = nil;
}
