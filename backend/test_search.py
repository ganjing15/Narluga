import asyncio
from google_genai_service import web_search_sources

async def main():
    print("Testing 'earth movement and four seasons'")
    results = await web_search_sources("earth movement and four seasons")
    print(results)

if __name__ == "__main__":
    asyncio.run(main())
