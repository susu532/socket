import express from 'express'
import cors from 'cors'
import { Server, LobbyRoom, RelayRoom } from 'colyseus'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { createServer } from 'http'
import { SoccerRoom } from './rooms/SoccerRoom.js'

const app = express()
app.use(cors())
app.use(express.json())

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Create HTTP server
const httpServer = createServer(app)

// Create Colyseus server
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer })
})

// Register room
gameServer.define('soccer', SoccerRoom)

// Start server
const port = Number(process.env.PORT) || 2567
httpServer.listen(port, () => {
  console.log(`🚀 Colyseus server running on port ${port}`)
})

