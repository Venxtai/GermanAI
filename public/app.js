// API Base URL
const API_BASE = 'http://localhost:3000/api';

// State
let currentConversationId = null;
let currentUnit = 1;
let isSessionActive = false;
let peerConnection = null;
let dataChannel = null;
let audioElement = null;
let microphoneTrack = null;
let lastTranscriptionId = null;
let waitingForResponse = false;

// DOM Elements
const unitSelection = document.getElementById('unitSelection');
const conversationScreen = document.getElementById('conversationScreen');
const unitNumberInput = document.getElementById('unitNumber');
const unitInfo = document.getElementById('unitInfo');
const unitTitle = document.getElementById('unitTitle');
const unitDescription = document.getElementById('unitDescription');
const unitVocabulary = document.getElementById('unitVocabulary');
const startButton = document.getElementById('startButton');
const endButton = document.getElementById('endButton');
const currentUnitBadge = document.getElementById('currentUnit');
const conversationHistory = document.getElementById('conversationHistory');
const recordButton = document.getElementById('recordButton');
const recordingIndicator = document.getElementById('recordingIndicator');
const statusText = document.getElementById('statusText');
const transcript = document.getElementById('transcript');
const loadingOverlay = document.getElementById('loadingOverlay');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    checkMicrophonePermission();
    // Load unit 1 info by default
    loadUnitInfo(1);
});

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Unit number input change
    unitNumberInput.addEventListener('input', async () => {
        const unitNum = parseInt(unitNumberInput.value);
        if (unitNum >= 1 && unitNum <= 104) {
            await loadUnitInfo(unitNum);
        }
    });

    // Start conversation button
    startButton.addEventListener('click', startConversation);

    // End conversation button
    endButton.addEventListener('click', endConversation);

    // Record button (hold to record)
    recordButton.addEventListener('mousedown', startRecording);
    recordButton.addEventListener('mouseup', stopRecording);
    recordButton.addEventListener('mouseleave', () => {
        if (isRecording) stopRecording();
    });

    // Touch support for mobile
    recordButton.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startRecording();
    });
    recordButton.addEventListener('touchend', (e) => {
        e.preventDefault();
        stopRecording();
    });
}

/**
 * Start recording - Enable microphone input
 */
async function startRecording() {
    if (!isSessionActive || !microphoneTrack) return;
    
    // Enable microphone
    microphoneTrack.enabled = true;
    
    // Update UI
    recordButton.classList.add('recording');
    recordingIndicator.classList.add('active');
    statusText.textContent = 'Recording...';
}

/**
 * Stop recording - Disable microphone and request AI response
 */
function stopRecording() {
    if (!isSessionActive || !microphoneTrack) return;
    
    // Disable microphone
    microphoneTrack.enabled = false;
    
    // Commit the audio buffer (this triggers transcription)
    sendRealtimeEvent({
        type: 'input_audio_buffer.commit'
    });
    
    // Set flag to request response after transcription completes
    waitingForResponse = true;
    
    // Update UI
    recordButton.classList.remove('recording');
    recordingIndicator.classList.remove('active');
    statusText.textContent = 'Processing...';
}

/**
 * Check microphone permission
 */
async function checkMicrophonePermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        console.log('Microphone access granted');
    } catch (error) {
        console.error('Microphone access denied:', error);
        alert('Please allow microphone access to use the app.');
    }
}

/**
 * Create a message element
 */
function createMessage(type, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    // Add avatar for AI messages
    if (type === 'ai') {
        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = '👨‍🏫';
        messageDiv.appendChild(avatar);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = type === 'ai' ? 'AI Teacher' : 'You';

    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    textDiv.textContent = text;

    contentDiv.appendChild(label);
    contentDiv.appendChild(textDiv);
    messageDiv.appendChild(contentDiv);
    
    return messageDiv;
}

/**
 * Load unit information
 */
async function loadUnitInfo(unitNum) {
    try {
        const response = await fetch(`${API_BASE}/units/${unitNum}`);
        
        if (response.ok) {
            const unit = await response.json();
            displayUnitInfo(unit);
        } else {
            // Unit not found, hide info
            unitInfo.classList.add('hidden');
        }
    } catch (error) {
        console.error('Error loading unit info:', error);
        unitInfo.classList.add('hidden');
    }
}

/**
 * Display unit information
 */
function displayUnitInfo(unit) {
    unitTitle.textContent = `Practice Your German for Unit ${unit.unit}`;
    //unitDescription.textContent = '';
    
    unitInfo.classList.remove('hidden');
}

/**
 * Start a new conversation
 */
async function startConversation() {
    currentUnit = parseInt(unitNumberInput.value);
    
    // Skip unit 3 - it doesn't exist
    if (currentUnit === 3) {
        alert('Unit 3 is not available. Please select a different unit.');
        return;
    }
    
    if (currentUnit < 1 || currentUnit > 104) {
        alert('Please select a unit between 1 and 104');
        return;
    }

    showLoading(true);

    try {
        console.log('Starting conversation for Unit', currentUnit);
        
        // Get unit info for system instructions
        const unitResponse = await fetch(`${API_BASE}/units/${currentUnit}`);
        const unitData = unitResponse.ok ? await unitResponse.json() : null;
        console.log('Unit data loaded:', unitData);

        // Get ephemeral token for Realtime API
        console.log('Fetching token...');
        const tokenResponse = await fetch('/token');
        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            throw new Error(`Token request failed: ${errorText}`);
        }
        const data = await tokenResponse.json();
        console.log('Token received');
        const EPHEMERAL_KEY = data.value;

        // Create peer connection
        const pc = new RTCPeerConnection();

        // Set up to play remote audio from the AI
        audioElement = document.createElement('audio');
        audioElement.autoplay = true;
        audioElement.volume = 1.0; // Maximum volume (100%)
        pc.ontrack = (e) => {
            audioElement.srcObject = e.streams[0];
        };

        // Add local audio track for microphone input
        const ms = await navigator.mediaDevices.getUserMedia({ 
            audio: true 
        });
        microphoneTrack = ms.getTracks()[0];
        microphoneTrack.enabled = false; // Start muted
        pc.addTrack(microphoneTrack);

        // Set up data channel for sending events to the API
        const dc = pc.createDataChannel('oai-events');
        peerConnection = pc;
        dataChannel = dc;

        // Start the session using the Session Description Protocol (SDP)
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const baseUrl = 'https://api.openai.com/v1/realtime';
        const model = 'gpt-4o-realtime-preview-2024-12-17';
        
        console.log('Sending SDP offer to OpenAI...');
        const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
            method: 'POST',
            body: offer.sdp,
            headers: {
                Authorization: `Bearer ${EPHEMERAL_KEY}`,
                'Content-Type': 'application/sdp'
            }
        });

        if (!sdpResponse.ok) {
            const errorText = await sdpResponse.text();
            console.error('SDP response error:', errorText);
            throw new Error(`Failed to establish WebRTC connection: ${sdpResponse.status} ${errorText}`);
        }

        console.log('SDP answer received');
        const answer = {
            type: 'answer',
            sdp: await sdpResponse.text()
        };
        await pc.setRemoteDescription(answer);
        console.log('Remote description set');

        isSessionActive = true;

        // Wait for data channel to open
        dc.addEventListener('open', () => {
            console.log('Data channel opened');
            
            // Configure session with German language and unit constraints
            const systemInstructions = generateSystemInstructions(unitData);
            
            sendRealtimeEvent({
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: systemInstructions,
                    voice: 'verse',
                    input_audio_format: 'pcm16',
                    output_audio_format: 'pcm16',
                    input_audio_transcription: {
                        model: 'whisper-1',
                        language: 'de'
                    },
                    turn_detection: null,
                    temperature: 0.8,
                    max_response_output_tokens: 300
                }
            });

            // Trigger AI to speak first
            sendRealtimeEvent({ type: 'response.create' });
        });

        // Handle incoming events
        dc.addEventListener('message', (e) => {
            const event = JSON.parse(e.data);
            handleRealtimeEvent(event);
        });

        // Update UI
        currentUnitBadge.textContent = `Unit ${currentUnit}`;
        conversationHistory.innerHTML = '';
        statusText.textContent = 'Hold button to speak';
        recordButton.disabled = false;

        // Switch to conversation screen
        unitSelection.classList.remove('active');
        conversationScreen.classList.add('active');

    } catch (error) {
        console.error('Error starting conversation:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        alert(`Error starting conversation: ${error.message}\n\nCheck console for details.`);
    } finally {
        showLoading(false);
    }
}

/**
 * End conversation
 */
async function endConversation() {
    // Close WebRTC connection
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (audioElement) {
        audioElement.srcObject = null;
        audioElement = null;
    }

    isSessionActive = false;
    currentConversationId = null;
    recordButton.disabled = true;

    // Switch back to unit selection
    conversationScreen.classList.remove('active');
    unitSelection.classList.add('active');
}

/**
 * Generate system instructions based on unit data
 */
function generateSystemInstructions(unitData) {
    if (!unitData) {
        return `You are a friendly German conversation partner. Speak naturally in German at a beginner level. Keep your responses very short.`;
    }

    const vocab = unitData.vocabulary?.join(', ') || '';
    const phrases = unitData.phrases?.join(', ') || '';
    
    return `You are a friendly German teacher having natural conversations with students learning Unit ${unitData.unit}: ${unitData.title}.

**ALLOWED VOCABULARY - You can ONLY use these words from Unit ${unitData.unit}:**
${vocab}

**ALLOWED PHRASES:**
${phrases}

**YOUR TASK:**
- You are the teacher - have a GENUINE, NATURAL conversation with the student
- Form natural German sentences using ONLY the words from the vocabulary list above
- Ask real conversational questions like "Hast du Hausaufgabe?" (Did you do homework?) instead of "Wie heißt 'homework' auf Deutsch?"
- Be creative and conversational, but strictly limited to Unit ${unitData.unit} vocabulary
- Ask questions, respond to student answers, and guide the conversation
- LISTEN to what the student actually says and use their response to think of relevant follow-up questions
- DO NOT just say "Gut!" or "Sehr gut!" after every answer - respond naturally based on what they said
- CRITICAL PRONUNCIATION: When speaking English words, SWITCH TO ENGLISH ACCENT. Do NOT use German pronunciation for English words.
- PRONUNCIATION INSTRUCTION: Treat English words as if you are speaking English momentarily. Say "name" as /neɪm/ (English "naym"), NOT /naːmə/ (German "nah-meh"). Say "page" as /peɪdʒ/ (English "payj"), NOT /paːɡə/ (German "pah-geh"). Use native English pronunciation.
- Use the CORRECT English translation for each German word (see vocabulary mapping below)
- DO NOT introduce yourself with a name - you are simply the teacher
- DO NOT ask translation questions like "Wie heißt X auf Deutsch?" - have real conversations instead
- Keep responses EXTREMELY short - this is for absolute beginners
- Have at least 8-10 conversational exchanges before saying goodbye
- Track how well the student participates in the conversation
- Gently correct if they use wrong vocabulary or grammar
- Before saying goodbye, give the student brief feedback on their conversation skills
- CRITICAL: DO NOT ask yes/no questions (like "Spielst du gerne Fußball?"). Instead, ask OPEN-ENDED questions that require the student to respond with full sentences (like "Was machst du gerne?" or "Wo wohnst du?" or "Was studierst du?")
- The goal is to get the student to SPEAK German sentences, not just answer "ja" or "nein"


**VOCABULARY MAPPINGS (German → English):**
- die Seite → "page"
- die Hausaufgabe → "homework"
- der Name → "name" when asking the student how to say "name" in German, pronounce as English "name"
- die Lehrkraft → "teacher"
- fragen → "ask"
- lesen → "read"
- gut → "good"
- schlecht → "bad"

**STRICT RULES:**
1. ONLY use words from the Unit ${unitData.unit} vocabulary list - no exceptions
2. Maximum 3-5 words per response - this is critical for beginners
3. Have NATURAL conversations - ask about real things like "Hast du die Hausaufgabe?" (Did you do homework?) instead of asking for translations
4. DO NOT ask "Wie heißt X auf Deutsch?" - have genuine conversations instead
5. ANSWER VALIDATION: Accept student's German responses even if grammar isn't perfect - focus on vocabulary usage
6. GREETING: After student tells you their name, greet them by name ONCE. Example: "Freut mich, [Name]! Wie geht's?"
7. If student responds well: AVOID repeating "Gut!" or "Sehr gut!" after every single response - instead, use their answer to ask a relevant follow-up question. Example: If they say "Ich wohne in Berlin", respond with "Und woher kommst du?" instead of "Gut! Woher kommst du?"
8. If student uses wrong vocabulary: gently correct them in context. Example: "Nein, das heißt 'die Seite'."
9. DO NOT say "Auf Wiedersehen!" until you've had at least 8-10 conversational exchanges
10. DO NOT ask "Wie geht's?" more than once per conversation
11. DO NOT use the student's name repeatedly - say it once maximum
12. Keep the conversation flowing naturally - ask follow-up questions based on their answers
13. BEFORE saying "Auf Wiedersehen!", tell the student brief feedback on their conversation using simple German
14. ABSOLUTELY NO YES/NO QUESTIONS: Never ask questions that can be answered with just "ja" or "nein". Always ask open-ended W-questions (Wie, Was, Wo, Woher, Wer) that require full sentence responses from the student.

**GOOD QUESTIONS (Open-ended):**
- "Was machst du gerne?" (requires: "Ich mache...")
- "Wo wohnst du?" (requires: "Ich wohne in...")
- "Was studierst du?" (requires: "Ich studiere...")
- "Woher kommst du?" (requires: "Ich komme aus...")

**BAD QUESTIONS (Yes/No - AVOID THESE):**
- "Spielst du gerne Fußball?" (only requires: "ja" or "nein")
- "Machst du Fotos?" (only requires: "ja" or "nein")
- "Singst du gerne?" (only requires: "ja" or "nein")

**Example responses (COPY THIS BREVITY):**
- "Hallo! Wie heißt du?"
- "Freut mich! Wo wohnst du?"
- "Und woher kommst du?"
- "Was studierst du?"
- "Was machst du gerne?"
- "Wer ist deine Lehrkraft?"
- (continue natural conversation with open-ended questions...)
- "Sehr gut! Du sprichst gut!"
- "Auf Wiedersehen!"

Create natural, varied sentences using ONLY Unit ${unitData.unit} vocabulary.`;
}

/**
 * Send event to Realtime API
 */
function sendRealtimeEvent(event) {
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify(event));
    }
}

/**
 * Handle incoming events from Realtime API
 */
function handleRealtimeEvent(event) {
    console.log('Realtime event:', event.type, event);

    switch (event.type) {
        case 'conversation.item.created':
            // Only log, don't add message here (handled by transcription.completed)
            if (event.item.role === 'user') {
                console.log('User item created:', event.item);
            }
            break;

        case 'conversation.item.input_audio_transcription.completed':
            // User speech transcription completed - don't display it
            console.log('Transcription completed:', event);
            const transcriptionId = event.item_id + event.content_index;
            if (event.transcript && event.transcript.trim() && transcriptionId !== lastTranscriptionId) {
                lastTranscriptionId = transcriptionId;
                // Don't add user message to chat - only show AI responses
            }
            
            // If we're waiting for response, request it now that transcription is done
            if (waitingForResponse) {
                waitingForResponse = false;
                sendRealtimeEvent({
                    type: 'response.create'
                });
            }
            break;

        case 'input_audio_buffer.speech_started':
            console.log('Speech detected');
            statusText.textContent = 'Listening...';
            break;

        case 'input_audio_buffer.speech_stopped':
            console.log('Speech stopped');
            statusText.textContent = 'Processing...';
            break;

        case 'response.audio_transcript.delta':
            // Update AI message with transcript as it's being generated
            updateAIMessage(event.delta);
            break;

        case 'response.audio_transcript.done':
            // Finalize AI message
            finalizeAIMessage(event.transcript);
            break;

        case 'response.done':
            statusText.textContent = 'Listening...';
            break;

        case 'error':
            console.error('Realtime API error:', event.error);
            statusText.textContent = 'Error occurred';
            break;
    }
}

let currentAIMessageElement = null;

/**
 * Update AI message as transcript comes in
 */
function updateAIMessage(delta) {
    if (!currentAIMessageElement) {
        currentAIMessageElement = createMessage('ai', delta);
        conversationHistory.appendChild(currentAIMessageElement);
    } else {
        const textDiv = currentAIMessageElement.querySelector('.message-text');
        textDiv.textContent += delta;
    }
    conversationHistory.scrollTop = conversationHistory.scrollHeight;
}

/**
 * Finalize AI message
 */
function finalizeAIMessage(fullTranscript) {
    if (currentAIMessageElement) {
        const textDiv = currentAIMessageElement.querySelector('.message-text');
        textDiv.textContent = fullTranscript;
        currentAIMessageElement = null;
    } else if (fullTranscript) {
        addMessage('ai', fullTranscript);
    }
}

/**
 * Add message to conversation history
 */
function addMessage(type, text) {
    const messageDiv = createMessage(type, text);
    conversationHistory.appendChild(messageDiv);

    // Scroll to bottom
    conversationHistory.scrollTop = conversationHistory.scrollHeight;
}

/**
 * Show/hide loading overlay
 */
function showLoading(show) {
    if (show) {
        loadingOverlay.classList.remove('hidden');
    } else {
        loadingOverlay.classList.add('hidden');
    }
}
