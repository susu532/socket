import { Server } from 'colyseus'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { createServer } from 'http'
import express from 'express'
import cors from 'cors'
import { SoccerRoom } from './rooms/SoccerRoom.js'

const port = process.env.PORT || 2567
const app = express()

app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
  res.send('⚽ Soccer Colyseus Server is Running!')
})

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: createServer(app)
  })
})

gameServer.define('soccer', SoccerRoom)

gameServer.listen(port)
console.log(`🚀 Colyseus server running on port ${port}`)
