import { Server, matchMaker } from 'colyseus'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { createServer } from 'http'
import express from 'express'
import cors from 'cors'
import { SoccerRoom } from './rooms/SoccerRoom.js'
import { getRoomIdByCode } from './roomRegistry.js'

const port = process.env.PORT || 2567
const app = express()

app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
  res.send('⚽ Soccer Colyseus Server is Running!')
})

app.get('/rooms/resolve/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase()
  if (!code) return res.status(400).json({ error: 'Missing code' })

  const roomId = getRoomIdByCode(code)
  if (!roomId) return res.status(404).json({ error: 'Room not found' })

  return res.json({ roomId })
})

app.get('/rooms/public', async (req, res) => {
  try {
    const rooms = await matchMaker.query({ name: 'soccer' })
    const publicRooms = (rooms || []).filter((r) => r?.metadata?.isPublic !== false)
    return res.json(publicRooms)
  } catch (err) {
    console.error('Failed to query public rooms:', err)
    return res.status(500).json({ error: 'Failed to list rooms' })
  }
})

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: createServer(app)
  })
})

gameServer.define('soccer', SoccerRoom)

gameServer.listen(port)
console.log(`🚀 Colyseus server running on port ${port}`)
