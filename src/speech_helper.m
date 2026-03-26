// speech_helper.m — ObjC helper for speech recognition with block-based APIs
//
// This provides C-callable functions that wrap the block-based Speech framework APIs,
// allowing the Zig code to use speech recognition without directly creating ObjC blocks.

#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#include <math.h>

// Callback function type for transcription results
typedef void (*TranscriptionCallback)(const char *text, int isFinal, void *context);

// Global state (single instance for simplicity)
static AVAudioEngine *audioEngine = nil;
static SFSpeechRecognizer *speechRecognizer = nil;
static SFSpeechAudioBufferRecognitionRequest *recognitionRequest = nil;
static SFSpeechRecognitionTask *recognitionTask = nil;
static TranscriptionCallback transcriptionCallback = NULL;
static void *callbackContext = NULL;

// Initialize the speech recognition system
int speech_init(void) {
    if (speechRecognizer != nil) return 1; // Already initialized
    
    // Request microphone permission on macOS
    if (@available(macOS 10.14, *)) {
        AVAuthorizationStatus micStatus = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
        
        if (micStatus == AVAuthorizationStatusNotDetermined) {
            dispatch_semaphore_t micSem = dispatch_semaphore_create(0);
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
                dispatch_semaphore_signal(micSem);
            }];
            dispatch_semaphore_wait(micSem, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        } else if (micStatus == AVAuthorizationStatusDenied) {
            return 0;
        }
    }
    
    // Check authorization
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
    
    // Create recognizer
    speechRecognizer = [[SFSpeechRecognizer alloc] init];
    if (!speechRecognizer || !speechRecognizer.isAvailable) return 0;
    
    // Create audio engine (uses system default input device)
    audioEngine = [[AVAudioEngine alloc] init];
    
    return 1;
}

// Start listening with the given callback
int speech_start(TranscriptionCallback callback, void *context) {
    if (!speechRecognizer || !audioEngine) {
        if (!speech_init()) return 0;
    }
    
    // Cancel any existing task
    if (recognitionTask) {
        [recognitionTask cancel];
        recognitionTask = nil;
    }
    
    transcriptionCallback = callback;
    callbackContext = context;
    
    // Create recognition request
    recognitionRequest = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    recognitionRequest.shouldReportPartialResults = YES;
    if (speechRecognizer.supportsOnDeviceRecognition) {
        recognitionRequest.requiresOnDeviceRecognition = YES;
    }
    
    // Get input node - this uses current system default input device
    AVAudioInputNode *inputNode = audioEngine.inputNode;
    AVAudioFormat *format = [inputNode outputFormatForBus:0];
    
    // Install tap to capture audio
    [inputNode installTapOnBus:0 
                    bufferSize:1024 
                        format:format 
                         block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        [recognitionRequest appendAudioPCMBuffer:buffer];
    }];
    
    // Start audio engine
    NSError *error = nil;
    [audioEngine prepare];
    if (![audioEngine startAndReturnError:&error]) {
        NSLog(@"Audio engine failed to start: %@", error);
        return 0;
    }
    
    // Start recognition task
    recognitionTask = [speechRecognizer recognitionTaskWithRequest:recognitionRequest
                                                     resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        if (result && transcriptionCallback) {
            NSString *text = result.bestTranscription.formattedString;
            transcriptionCallback([text UTF8String], result.isFinal, callbackContext);
        }
    }];
    
    return 1;
}

// Stop listening and clean up
void speech_stop(void) {
    if (audioEngine.isRunning) {
        [audioEngine stop];
        [audioEngine.inputNode removeTapOnBus:0];
    }
    
    if (recognitionRequest) {
        [recognitionRequest endAudio];
        recognitionRequest = nil;
    }
    
    if (recognitionTask) {
        [recognitionTask cancel];
        recognitionTask = nil;
    }
    
    transcriptionCallback = NULL;
    callbackContext = NULL;
}

// Check if currently listening
int speech_is_listening(void) {
    return audioEngine != nil && audioEngine.isRunning;
}

// Get the current input device name
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
    audioEngine = nil;
    speechRecognizer = nil;
}
