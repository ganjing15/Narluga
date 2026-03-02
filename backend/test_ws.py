import asyncio
import websockets
import sys

async def test():
    uri = "ws://localhost:8000/ws/live?token=dummy"
    print(f"Connecting to {uri}...")
    try:
        async with websockets.connect(uri) as ws:
            print("Connected!")
            await ws.send('{"type":"init_sources", "sources": [], "research_mode": "fast"}')
            print("Sent init.")
            msg = await ws.recv()
            print(f"Received: {msg}")
    except Exception as e:
        print(f"Error: {e}")

asyncio.run(test())
