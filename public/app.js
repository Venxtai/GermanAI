// API Base URL
const API_BASE = 'http://localhost:3000/api';

// State
let currentConversationId = null;
let currentUnit = 1;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

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
    unitTitle.textContent = unit.title || `Einheit ${unit.unit}`;
    unitDescription.textContent = unit.description || '';
    
    // Display vocabulary (limit to first 20 words for preview)
    const vocabPreview = unit.vocabulary.slice(0, 20).join(', ');
    const moreVocab = unit.vocabulary.length > 20 ? ` (+${unit.vocabulary.length - 20} mehr)` : '';
    unitVocabulary.textContent = vocabPreview + moreVocab;
    
    unitInfo.classList.remove('hidden');
}

/**
 * Start a new conversation
 */
async function startConversation() {
    currentUnit = parseInt(unitNumberInput.value);
    
    if (currentUnit < 1 || currentUnit > 104) {
        alert('Please select a unit between 1 and 104');
        return;
    }

    showLoading(true);

    try {
        const response = await fetch(`${API_BASE}/conversation/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ unitNumber: currentUnit })
        });

        if (!response.ok) {
            throw new Error('Failed to start conversation');
        }

        const data = await response.json();
        currentConversationId = data.conversationId;

        // Update UI
        currentUnitBadge.textContent = `Unit ${currentUnit}`;
        conversationHistory.innerHTML = '';
        
        // Add AI greeting
        addMessage('ai', data.message);

        // Speak the greeting
        await speakText(data.message);

        // Switch to conversation screen
        unitSelection.classList.remove('active');
        conversationScreen.classList.add('active');

    } catch (error) {
        console.error('Error starting conversation:', error);
        alert('Error starting conversation. Please check the server connection.');
    } finally {
        showLoading(false);
    }
}

/**
 * End conversation
 */
async function endConversation() {
    if (currentConversationId) {
        try {
            await fetch(`${API_BASE}/conversation/end`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ conversationId: currentConversationId })
            });
        } catch (error) {
            console.error('Error ending conversation:', error);
        }

        currentConversationId = null;
    }

    // Switch back to unit selection
    conversationScreen.classList.remove('active');
    unitSelection.classList.add('active');
}

/**
 * Start recording audio
 */
async function startRecording() {
    if (isRecording) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            await processAudio(audioBlob);
            
            // Stop all tracks
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;

        // Update UI
        recordButton.classList.add('recording');
        recordingIndicator.classList.add('active');
        statusText.textContent = 'Recording...';
        transcript.classList.add('hidden');

    } catch (error) {
        console.error('Error starting recording:', error);
        alert('Error accessing microphone');
    }
}

/**
 * Stop recording audio
 */
function stopRecording() {
    if (!isRecording || !mediaRecorder) return;

    mediaRecorder.stop();
    isRecording = false;

    // Update UI
    recordButton.classList.remove('recording');
    recordingIndicator.classList.remove('active');
    statusText.textContent = 'Processing recording...';
}

/**
 * Process recorded audio
 */
async function processAudio(audioBlob) {
    showLoading(true);

    try {
        // Convert audio to text
        const transcription = await transcribeAudio(audioBlob);
        
        if (!transcription) {
            statusText.textContent = 'No speech detected. Please try again.';
            showLoading(false);
            return;
        }

        // Display transcription
        transcript.textContent = `You: "${transcription}"`;
        transcript.classList.remove('hidden');

        // Add user message to conversation
        addMessage('user', transcription);

        // Get AI response
        const aiResponse = await sendMessage(transcription);

        if (aiResponse) {
            // Add AI message
            addMessage('ai', aiResponse);

            // Speak AI response
            await speakText(aiResponse);
        }

        statusText.textContent = 'Ready to speak';

    } catch (error) {
        console.error('Error processing audio:', error);
        statusText.textContent = 'Processing error';
    } finally {
        showLoading(false);
    }
}

/**
 * Transcribe audio to text
 */
async function transcribeAudio(audioBlob) {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');

    try {
        const response = await fetch(`${API_BASE}/speech-to-text`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error('Transcription failed');
        }

        const data = await response.json();
        return data.text;

    } catch (error) {
        console.error('Error transcribing audio:', error);
        return null;
    }
}

/**
 * Send message to AI and get response
 */
async function sendMessage(message) {
    try {
        const response = await fetch(`${API_BASE}/conversation/message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                conversationId: currentConversationId,
                message: message
            })
        });

        if (!response.ok) {
            throw new Error('Failed to get response');
        }

        const data = await response.json();
        return data.response;

    } catch (error) {
        console.error('Error sending message:', error);
        return null;
    }
}

/**
 * Convert text to speech and play
 */
async function speakText(text) {
    try {
        const response = await fetch(`${API_BASE}/text-to-speech`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text })
        });

        if (!response.ok) {
            throw new Error('TTS failed');
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        return new Promise((resolve) => {
            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                resolve();
            };
            audio.play();
        });

    } catch (error) {
        console.error('Error speaking text:', error);
    }
}

/**
 * Add message to conversation history
 */
function addMessage(type, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = type === 'ai' ? 'AI Teacher' : 'You';

    const textDiv = document.createElement('div');
    textDiv.className = 'message-text';
    textDiv.textContent = text;

    messageDiv.appendChild(label);
    messageDiv.appendChild(textDiv);
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
