import asyncio
import websockets
import json

async def test_ws():
    uri = "ws://localhost:8000/ws/live"
    async with websockets.connect(uri) as websocket:
        # Send initial source
        source_msg = {
            "type": "init_sources",
            "sources": [{"type": "text", "content": "Test text"}]
        }
        await websocket.send(json.dumps(source_msg))

        # Wait for messages
        while True:
            try:
                response = await websocket.recv()
                print(f"Received: {response[:100]}")
            except websockets.exceptions.ConnectionClosed as e:
                print(f"Connection closed: {e}")
                break

asyncio.run(test_ws())
