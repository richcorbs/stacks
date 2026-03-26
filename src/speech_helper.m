// speech_helper.m — ObjC helper for speech recognition with block-based APIs
//
// This provides C-callable functions that wrap the block-based Speech framework APIs,
// allowing the Zig code to use speech recognition without directly creating ObjC blocks.

#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>

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
    
    // Check authorization
    SFSpeechRecognizerAuthorizationStatus status = [SFSpeechRecognizer authorizationStatus];
    if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
        // Request authorization
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block BOOL authorized = NO;
        
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            authorized = (status == SFSpeechRecognizerAuthorizationStatusAuthorized);
            dispatch_semaphore_signal(sem);
        }];
        
        // Wait up to 30 seconds for user response
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
        
        if (!authorized) {
            NSLog(@"Speech recognition not authorized");
            return 0;
        }
    }
    
    // Create recognizer
    speechRecognizer = [[SFSpeechRecognizer alloc] init];
    if (!speechRecognizer || !speechRecognizer.isAvailable) {
        NSLog(@"Speech recognizer not available");
        return 0;
    }
    
    // Check on-device support
    if (!speechRecognizer.supportsOnDeviceRecognition) {
        NSLog(@"On-device recognition not supported");
        return 0;
    }
    
    // Create audio engine
    audioEngine = [[AVAudioEngine alloc] init];
    
    NSLog(@"Speech recognition initialized (on-device)");
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
    recognitionRequest.requiresOnDeviceRecognition = YES;
    
    // Get input node
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
        
        if (error) {
            NSLog(@"Recognition error: %@", error);
        }
    }];
    
    NSLog(@"Speech recognition started");
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
    
    NSLog(@"Speech recognition stopped");
}

// Check if currently listening
int speech_is_listening(void) {
    return audioEngine != nil && audioEngine.isRunning;
}

// Clean up everything
void speech_cleanup(void) {
    speech_stop();
    audioEngine = nil;
    speechRecognizer = nil;
}
