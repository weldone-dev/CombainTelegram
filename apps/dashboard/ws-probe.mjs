import { io } from 'socket.io-client';
const socket = io('http://127.0.0.1:3001/events', { transports: ['websocket'] });
socket.on('connect', () => console.log('connected', socket.id));
for (const ev of ['message.new','message.edited','message.deleted','message.read','chat.typing','connection']) {
  socket.on(ev, (payload) => console.log('EVENT', ev, JSON.stringify(payload).slice(0, 260)));
}
setTimeout(() => { socket.close(); process.exit(0); }, 40000);
