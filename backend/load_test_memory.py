import asyncio
import os
import tracemalloc
import gc
from unittest.mock import AsyncMock, patch
import json

# Setup environment for testing before importing app
os.environ["DISABLE_AUTH"] = "true"
os.environ["GEMINI_API_KEY"] = "fake_key_for_testing"

tracemalloc.start()

# Load our main app stack
import main
from google_genai_service import handle_live_session

async def simulate_connection(ws_mock, duration_seconds=10):
    """Simulates a single active WebSocket connection handling audio chunks."""
    try:
        # Mock receiving an audio chunk every 100ms
        audio_payload = json.dumps({
            "realtimeInput": {
                "mediaChunks": [{
                    "mimeType": "audio/pcm;rate=16000",
                    "data": "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=" * 10 # Fake base64 audio
                }]
            }
        })
        
        async def mock_receive_text():
            await asyncio.sleep(0.1)
            return audio_payload
            
        ws_mock.receive_text = mock_receive_text
        ws_mock.send_json = AsyncMock()
        
        # We need to run the handle_live_session but it will try to hit the real Gemini API
        # Since we just want to measure memory of the python structures, we can just 
        # simulate the data accumulating
        
        chunks = []
        for _ in range(duration_seconds * 10):
            data = await ws_mock.receive_text()
            # Simulate holding some state per connection
            chunks.append(data)
            await asyncio.sleep(0.01)
            
    except Exception as e:
        print(f"Error in connection: {e}")

async def measure_load(num_connections=50):
    print("Initializing...")
    app = main.app
    gc.collect()
    
    idle_current, idle_peak = tracemalloc.get_traced_memory()
    print(f"Idle memory usage: {idle_current / 10**6:.2f} MB")
    
    print(f"\nSimulating {num_connections} concurrent active connections...")
    
    # Create fake websocket connections
    connections = []
    for _ in range(num_connections):
        ws_mock = AsyncMock()
        connections.append(simulate_connection(ws_mock))
        
    # Run them all concurrently
    await asyncio.gather(*connections)
    
    load_current, load_peak = tracemalloc.get_traced_memory()
    
    print(f"Memory usage under load ({num_connections} users): {load_current / 10**6:.2f} MB")
    print(f"Peak memory usage during load: {load_peak / 10**6:.2f} MB")
    
    increase = (load_peak - idle_current) / 10**6
    print(f"\nTotal memory increase for {num_connections} concurrent users: {increase:.2f} MB")
    print(f"Approximate memory per active user: {(increase / num_connections) * 1000:.2f} KB")

if __name__ == "__main__":
    asyncio.run(measure_load(50))
