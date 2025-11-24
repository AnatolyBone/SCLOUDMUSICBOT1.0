import asyncio
import sys
import json
from shazamio import Shazam

async def main():
    try:
        # Читаем аргументы (путь к файлу)
        if len(sys.argv) < 2:
            print(json.dumps({"error": "No file path provided"}))
            return

        file_path = sys.argv[1]
        shazam = Shazam()
        
        # Распознаем
        out = await shazam.recognize(file_path)
        
        # Печатаем чистый JSON для Node.js
        print(json.dumps(out))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(main())
