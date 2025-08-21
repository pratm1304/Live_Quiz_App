// server.js - The back-end server for the real-time quiz app

// 1. Import necessary modules
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Initialize a new Socket.io server with CORS enabled to allow connections from different origins
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for development
        methods: ["GET", "POST"]
    }
});

// 2. Data Store - In a real-world application, this data would be stored in a database (e.g., MongoDB, PostgreSQL)
const quizzes = {}; // Stores quiz data: quizzes[quizId] = { title, questions, roomCode }
const rooms = {}; // Stores active room data: rooms[roomCode] = { quizId, players, currentQuestion, leaderboard, timer, hostId, title }

// 3. Serve static files (the front-end HTML)
app.use(express.static(path.join(__dirname, '/')));

// Function to start a new question with a timer
function startQuestionTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    // Clear any existing timer
    if (room.timer) {
        clearTimeout(room.timer);
    }
    
    const quizId = room.quizId;
    const currentQuestionIndex = room.currentQuestion;
    const timeLimit = quizzes[quizId].questions[currentQuestionIndex].timeLimit;
    const currentQuestion = quizzes[quizId].questions[currentQuestionIndex];
    
    // Set a new timer for the question
    room.timer = setTimeout(() => {
        // Send question timeout with correct answer and results
        io.to(roomCode).emit('questionTimeout', {
            correctAnswer: currentQuestion.correctAnswer,
            results: room.leaderboard
        });
        
        console.log(`Question timed out in room: ${roomCode}`);
        
        // Wait 2.5 seconds (500ms delay + 2000ms display time) before advancing to next question
        setTimeout(() => {
            nextQuestion(roomCode);
        }, 2500);
        
    }, timeLimit * 1000); // Time limit is in seconds
}

function nextQuestion(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    room.currentQuestion++;
    const currentQuestionIndex = room.currentQuestion;
    const quizId = room.quizId;
    const currentQuiz = quizzes[quizId];
    
    // Check if there are more questions
    if (currentQuestionIndex < currentQuiz.questions.length) {
        io.to(roomCode).emit('newQuestion', currentQuiz.questions[currentQuestionIndex]);
        startQuestionTimer(roomCode); // Start the timer for the new question
    } else {
        const sortedLeaderboard = Object.values(room.leaderboard).sort((a, b) => b.score - a.score);
        io.to(roomCode).emit('quizFinished', sortedLeaderboard);
        console.log(`Quiz finished for room: ${roomCode}`);
    }
}

// 4. Socket.io Connection Handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // ----- Admin/Host Events -----

    // Handle 'createQuiz' event from the admin
    socket.on('createQuiz', (quizData) => {
        const quizId = `quiz-${Date.now()}`;
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase(); // Generate a random 4-letter room code
        
        quizzes[quizId] = quizData;
        
        rooms[roomCode] = {
            quizId: quizId,
            title: quizData.title, // Store the quiz title in the room
            players: [],
            currentQuestion: -1,
            leaderboard: {}, // { playerId: { name, score, answers: [] } }
            hostId: socket.id // Track the host
        };

        // Join the host to the room so they receive updates
        socket.join(roomCode);

        // Notify the host about the new room and quiz ID
        socket.emit('quizCreated', { roomCode: roomCode, quizId: quizId });
        console.log(`New quiz created with Room Code: ${roomCode}, Host: ${socket.id}`);
    });

    // Handle 'startQuiz' event from the admin
    socket.on('startQuiz', (roomCode) => {
        if (!rooms[roomCode]) {
            console.log(`Room ${roomCode} not found when trying to start quiz`);
            return;
        }
        
        rooms[roomCode].currentQuestion = 0; // Set to the first question
        const quizId = rooms[roomCode].quizId;
        const currentQuiz = quizzes[quizId];
        
        // Broadcast the first question to all players in the room
        io.to(roomCode).emit('newQuestion', currentQuiz.questions[0]);
        startQuestionTimer(roomCode);
        console.log(`Quiz started for room: ${roomCode}`);
    });

    // Handle 'nextQuestion' event from the admin
    socket.on('nextQuestion', (roomCode) => {
        console.log(`Next question requested for room: ${roomCode}`);
        nextQuestion(roomCode);
    });

    // ----- Player Events -----

    // Handle 'joinQuiz' event from a player
    socket.on('joinQuiz', ({ roomCode, name }) => {
        const normalizedRoomCode = roomCode.toUpperCase();
        if (!rooms[normalizedRoomCode]) {
            socket.emit('joinError', 'Room not found. Please check the code.');
            return;
        }

        // Add the player to the room
        socket.join(normalizedRoomCode);
        const player = { id: socket.id, name, score: 0 };
        rooms[normalizedRoomCode].players.push(player);
        rooms[normalizedRoomCode].leaderboard[socket.id] = { name: name, score: 0, answers: [] };
        
        // Get the room info
        const room = rooms[normalizedRoomCode];
        
        // Notify the player they have joined successfully (include quiz title)
        socket.emit('joinedRoom', {
            roomCode: normalizedRoomCode,
            quizTitle: room.title,
            players: room.players
        });
        
        // Notify all players in the room about the new player (including the host)
        io.to(normalizedRoomCode).emit('playerJoined', {
            players: room.players,
            quizTitle: room.title
        });
        
        console.log(`${name} (${socket.id}) joined room: ${normalizedRoomCode}`);
    });

    // Handle 'submitAnswer' event from a player
    socket.on('submitAnswer', ({ roomCode, answer }) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Check if player has already answered this question
        const playerAnswers = room.leaderboard[socket.id]?.answers || [];
        const hasAnsweredCurrentQuestion = playerAnswers.some(a => a.question === room.currentQuestion);
        if (hasAnsweredCurrentQuestion) {
            console.log(`Player ${socket.id} attempted to answer question ${room.currentQuestion} again`);
            return; // Prevent duplicate answers
        }

        const quiz = quizzes[room.quizId];
        const currentQuestion = quiz.questions[room.currentQuestion];
        const isCorrect = answer === currentQuestion.correctAnswer;
        
        // Update the player's score and answers
        if (room.leaderboard[socket.id]) {
            room.leaderboard[socket.id].answers.push({ 
                question: room.currentQuestion, 
                answer: answer, 
                correct: isCorrect 
            });
            if (isCorrect) {
                room.leaderboard[socket.id].score += 10; // Award points for a correct answer
            }
        }
        
        console.log(`Answer submitted in room ${roomCode} by ${room.leaderboard[socket.id]?.name}. Answer: ${answer}, Correct: ${isCorrect}.`);
        
        // DON'T send answer result immediately - wait until timer expires
        // socket.emit('answerResult', {
        //     isCorrect: isCorrect,
        //     correctAnswer: currentQuestion.correctAnswer
        // });
        
        // Send updated leaderboard ONLY to admin
        const sortedLeaderboard = Object.values(room.leaderboard).sort((a, b) => b.score - a.score);
        
        // Send to admin only
        if (room.hostId) {
            io.to(room.hostId).emit('updateLeaderboard', sortedLeaderboard);
        }
        
        // Send individual score update to the player who answered
        const playerScore = room.leaderboard[socket.id]?.score || 0;
        socket.emit('scoreUpdate', playerScore);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        // Find and remove the disconnected player from any room
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            // Check if this was the host
            if (room.hostId === socket.id) {
                console.log(`Host ${socket.id} disconnected from room: ${roomCode}`);
                // Clean up the room when host leaves
                if (room.timer) {
                    clearTimeout(room.timer);
                }
                delete rooms[roomCode];
                delete quizzes[room.quizId];
                io.to(roomCode).emit('hostDisconnected');
                break;
            }
            
            // Check if this was a player
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const playerName = room.players[playerIndex].name;
                room.players.splice(playerIndex, 1);
                delete room.leaderboard[socket.id];
                
                // Update all players in the room (include quiz title)
                io.to(roomCode).emit('playerJoined', {
                    players: room.players,
                    quizTitle: room.title
                });
                
                console.log(`${playerName} (${socket.id}) disconnected from room: ${roomCode}`);
                break;
            }
        }
        console.log(`User disconnected: ${socket.id}`);
    });
});

// 5. Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log('You can access the quiz app from your browser at this address.');
});