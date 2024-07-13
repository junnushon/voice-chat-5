'use strict';

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room');
const roomPassword = urlParams.get('password');

const leaveRoomButton = document.getElementById('leaveRoomButton');
const remoteAudio = document.getElementById('remoteAudio');
const roomTitle = document.getElementById('roomTitle');
const userCountDiv = document.getElementById('userCount');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const copyLinkButton = document.getElementById('copyLinkButton');
const nicknameDisplay = document.getElementById('nicknameDisplay');

let localStream;
let pcs = {};
let ws;
let nickname = '';

document.addEventListener('DOMContentLoaded', async () => {
    await fetchRoomTitle();
    nickname = prompt("Enter your nickname:");
    if (!nickname) {
        alert("Nickname is required!");
        window.location.href = '/';
        return;
    }
    nicknameDisplay.textContent = nickname; // 닉네임 표시 추가
    await start();
    await setupWebSocket();
    await call();
});

leaveRoomButton.onclick = leaveRoom;
sendButton.onclick = sendMessage;
chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        sendMessage();
    }
});

copyLinkButton.onclick = () => {
    const roomUrl = `${window.location.origin}/room.html?room=${roomId}`;
    navigator.clipboard.writeText(roomUrl).then(() => {
        alert('Room link copied to clipboard!');
    }).catch(err => {
        alert('Failed to copy the link.');
    });
};

async function fetchRoomTitle() {
    const response = await fetch('/rooms');
    const rooms = await response.json();
    const room = rooms.find(r => r.id === roomId);
    if (room) {
        roomTitle.textContent = room.name;
    }
}

async function setupWebSocket() {
    return new Promise((resolve, reject) => {
        let wsUrl = `ws://localhost:8000/ws?room=${roomId}`;
        if (roomPassword) {
            wsUrl += `&password=${roomPassword}`;
        }
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connection established');
            resolve();
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            alert('Failed to connect to the room. Please check the password and try again.');
            window.location.href = '/';
            reject(error);
        };

        ws.onmessage = async (event) => {
            const message = event.data;
            const data = JSON.parse(message);
            console.log('Received message:', data);

            if (data.type === 'user_count') {
                console.log(`Updating user count to ${data.user_count}`);
                if (userCountDiv) {
                    userCountDiv.textContent = `(${data.user_count})`;
                }
            } else if (data.from && data.sdp) {
                if (!pcs[data.from]) {
                    initializePeerConnection(data.from);
                }
                await pcs[data.from].setRemoteDescription(new RTCSessionDescription(data.sdp));
                if (data.sdp.type === 'offer') {
                    const answer = await pcs[data.from].createAnswer();
                    console.log('Created answer:', answer);
                    await pcs[data.from].setLocalDescription(answer);
                    ws.send(JSON.stringify({ from: 'your-id', to: data.from, sdp: pcs[data.from].localDescription }));
                    console.log('Sent answer SDP:', pcs[data.from].localDescription);
                }
            } else if (data.from && data.candidate) {
                try {
                    await pcs[data.from].addIceCandidate(new RTCIceCandidate(data.candidate));
                    console.log('Added ICE candidate:', data.candidate);
                } catch (e) {
                    console.error('Error adding received ICE candidate', e);
                }
            } else if (data.type === 'chat') {
                addChatMessage(data.message, data.nickname);
            }
        };

        ws.onclose = (event) => {
            if (event.reason === "Invalid password") {
                alert("Invalid password. Please try again.");
                window.location.href = '/';
            } else if (event.reason === "Room does not exist") {
                alert("Room does not exist. Please try again.");
                window.location.href = '/';
            }
        };
    });
}

async function start() {
    console.log('Starting local stream...');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 44100
            }
        });
        localStream = stream;
        console.log('Local stream started:', stream);
    } catch (e) {
        console.error('Error accessing media devices:', e);
    }
}

async function call() {
    console.log('Starting call...');

    initializePeerConnection('your-id');

    localStream.getTracks().forEach(track => {
        for (let peerId in pcs) {
            pcs[peerId].addTrack(track, localStream);
            console.log('Added local track:', track);
        }
    });

    for (let peerId in pcs) {
        try {
            const offer = await pcs[peerId].createOffer();
            console.log('Created offer:', offer);
            await pcs[peerId].setLocalDescription(offer);
            console.log('Set local description:', pcs[peerId].localDescription);
            ws.send(JSON.stringify({ from: 'your-id', to: peerId, sdp: pcs[peerId].localDescription }));
            console.log('Sent offer SDP:', pcs[peerId].localDescription);
        } catch (e) {
            console.error('Failed to create offer:', e);
        }
    }
}

function initializePeerConnection(peerId) {
    pcs[peerId] = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

    pcs[peerId].onicecandidate = e => {
        if (e.candidate) {
            console.log('Generated ICE candidate:', e.candidate);
            ws.send(JSON.stringify({ from: 'your-id', to: peerId, candidate: e.candidate }));
        }
    };

    pcs[peerId].oniceconnectionstatechange = e => {
        console.log('ICE connection state change:', pcs[peerId].iceConnectionState);
    };

    pcs[peerId].onconnectionstatechange = e => {
        console.log('Peer connection state change:', pcs[peerId].connectionState);
    };

    pcs[peerId].ontrack = event => {
        if (event.streams && event.streams[0]) {
            console.log('Received remote stream:', event.streams[0]);
            remoteAudio.srcObject = event.streams[0];
        }
    };
}

function hangup() {
    for (let peerId in pcs) {
        if (pcs[peerId]) {
            pcs[peerId].close();
            pcs[peerId] = null;
            console.log('Peer connection closed for peer:', peerId);
        }
    }
}

function leaveRoom() {
    hangup();
    window.location.href = '/';
}

function sendMessage() {
    const message = chatInput.value.trim();
    if (message) {
        ws.send(JSON.stringify({ type: 'chat', message, nickname }));
        addChatMessage(message, nickname, true);
        chatInput.value = '';
    }
}

function addChatMessage(message, nickname, isLocal = false) {
    const messageWrapper = document.createElement('div');
    const messageElement = document.createElement('div');
    messageElement.classList.add('chat-message');
    if (isLocal) {
        messageElement.classList.add('local');
        messageElement.innerHTML = message;
        messageWrapper.style.textAlign = 'right';
    } else {
        messageElement.innerHTML = `<strong>${nickname}:</strong> ${message}`;
        messageWrapper.style.textAlign = 'left';
    }
    messageWrapper.appendChild(messageElement);
    chatMessages.appendChild(messageWrapper);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
