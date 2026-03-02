import requests

res = requests.post("http://localhost:8000/search", json={"query": "earth movement and four seasons"})
print(res.json())
