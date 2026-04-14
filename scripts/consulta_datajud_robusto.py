import requests
import sys

API_KEY = "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw=="

def consultar_datajud(cpf):
    headers = {
        'Authorization': f'APIKey {API_KEY}',
        'Content-Type': 'application/json'
    }
    
    url = "https://api-publica.datajud.cnj.jus.br/api_publica_tjsp/_search"
    query = {"query": {"match": {"partes.cpf": cpf}}, "size": 1}
    
    try:
        response = requests.post(url, json=query, headers=headers, timeout=30)
        if response.status_code == 200:
            data = response.json()
            return data.get('hits', {}).get('total', {}).get('value', 0)
        return 0
    except:
        return 0

def main():
    cpf = sys.argv[1] if len(sys.argv) > 1 else ""
    total = consultar_datajud(cpf)
    
    if total == 0:
        print("VEREDITO: APROVADO")
    else:
        print("VEREDITO: REPROVADO")

if __name__ == "__main__":
    main()