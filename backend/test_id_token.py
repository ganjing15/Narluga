from google.oauth2 import id_token
from google.auth.transport import requests

def verify(token):
    try:
        request = requests.Request()
        id_info = id_token.verify_firebase_token(token, request)
        print("Success:", id_info)
    except Exception as e:
        print("Error:", e)

verify("dummy")
