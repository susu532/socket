export const codeToRoomId = new Map()
export const roomIdToCode = new Map()

export function registerPrivateRoom(roomId, code) {
  codeToRoomId.set(code, roomId)
  roomIdToCode.set(roomId, code)
}

export function unregisterRoom(roomId) {
  const code = roomIdToCode.get(roomId)
  if (code) {
    codeToRoomId.delete(code)
  }
  roomIdToCode.delete(roomId)
}

export function getRoomIdByCode(code) {
  return codeToRoomId.get(code)
}
