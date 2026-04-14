import requests
import sys
import time

API_KEY = "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw=="

def consultar_datajud(cpf, tentativas=3):
    """Consulta o Datajud com múltiplas tentativas"""
    
    headers = {
        'Authorization': f'APIKey {API_KEY}',
        'Content-Type': 'application/json'
    }
    
    url = "https://api-publica.datajud.cnj.jus.br/api_publica_tjsp/_search"
    query = {"query": {"match": {"partes.cpf": cpf}}, "size": 1}
    
    for tentativa in range(tentativas):
        try:
            print(f"[Tentativa {tentativa + 1}/{tentativas}] Consultando...", file=sys.stderr)
            response = requests.post(url, json=query, headers=headers, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                total = data.get('hits', {}).get('total', {}).get('value', 0)
                print(f"[OK] Resposta recebida: {total} processos", file=sys.stderr)
                return total
            else:
                print(f"[ERRO] HTTP {response.status_code}", file=sys.stderr)
                
        except requests.exceptions.Timeout:
            print(f"[TIMEOUT] Tentativa {tentativa + 1} falhou", file=sys.stderr)
        except Exception as e:
            print(f"[ERRO] {str(e)[:50]}", file=sys.stderr)
        
        if tentativa < tentativas - 1:
            print(f"[AGUARDANDO] 2 segundos antes da próxima tentativa...", file=sys.stderr)
            time.sleep(2)
    
    return -1  # Indica erro na consulta

def main():
    cpf = sys.argv[1] if len(sys.argv) > 1 else ""
    
    print(f"\n{'='*50}", file=sys.stderr)
    print(f"CONSULTA DATAJUD - CNJ", file=sys.stderr)
    print(f"{'='*50}", file=sys.stderr)
    print(f"CPF: {cpf}", file=sys.stderr)
    print(f"{'='*50}\n", file=sys.stderr)
    
    total = consultar_datajud(cpf)
    
    print(f"\n{'='*50}", file=sys.stderr)
    if total == -1:
        print("RESULTADO: ERRO NA CONSULTA", file=sys.stderr)
        print("VEREDITO: INDISPONIVEL", file=sys.stderr)
        print("VEREDITO: INDISPONIVEL")  # Para o Node.js ler
    elif total == 0:
        print("RESULTADO: NADA CONSTA", file=sys.stderr)
        print("VEREDITO: APROVADO", file=sys.stderr)
        print("VEREDITO: APROVADO")
    else:
        print(f"RESULTADO: {total} PROCESSO(S)", file=sys.stderr)
        print("VEREDITO: REPROVADO", file=sys.stderr)
        print("VEREDITO: REPROVADO")
    print(f"{'='*50}", file=sys.stderr)

if __name__ == "__main__":
    main()