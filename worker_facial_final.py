import cv2
import numpy as np
import insightface
from insightface.app import FaceAnalysis
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
import pickle
import re
import json
import time

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_PATH = os.path.join(BASE_DIR, "dataset_unificado")
CACHE_FILE = os.path.join(BASE_DIR, "encodings_cache.pkl")
VENDIDOS_FILE = os.path.join(BASE_DIR, "bicos_vendidos.json")
REPROVADOS_PATH = os.path.join(BASE_DIR, "dataset_reprovados")

print("🚀 Worker Facial - Filtro de Gênero Rigoroso via TXT e Nome")

face_app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
face_app.prepare(ctx_id=0, det_size=(640, 640))
print("✅ Modelo carregado")

# Lista expandida e rigorosa de nomes femininos comuns
NOMES_FEMININOS = [
    "MARCIA", "MARIA", "ANA", "DANIELA", "FERNANDA", "SIMONE", "CRISTIANE", "JULIANA",
    "PATRICIA", "LETICIA", "BEATRIZ", "ROBERTA", "CAMILA", "ALICE", "JULIA",
    "CAROLINA", "VANESSA", "TATIANE", "KARINA", "LUCIANA", "ANDREIA", "SANDRA",
    "CLAUDIA", "FABIANA", "JESSICA", "LAURA", "GABRIELA", "RAFAELA", "NATALIA",
    "PAULA", "ANTONIA", "DAIANA", "ADRIANA", "VIVIANE", "PRISCILA", "LUANA",
    "BRUNA", "AMANDA", "LARISSA", "MARIANA", "RENATA", "CIBELE", "KARINE",
    "LOUISE", "DEBORA", "DANUBIA", "DALILA", "CINTHIA", "FABIOLA", "KAREN"
]

def detectar_genero(caminho_imagem, nome_arquivo):
    # 1. Verifica rigorosamente no arquivo .txt correspondente se houver menção explícita de sexo/gênero
    txt_path = caminho_imagem.replace(".jpg", ".txt").replace(".png", ".txt")
    if os.path.exists(txt_path):
        try:
            with open(txt_path, "r", encoding="utf-8", errors="ignore") as f:
                conteudo = f.read().upper()
                if "SEXO: F" in conteudo or "GENERO: FEMININO" in conteudo or "MULHER" in conteudo:
                    return "MULHER"
                if "SEXO: M" in conteudo or "GENERO: MASCULINO" in conteudo or "HOMEM" in conteudo:
                    return "HOMEM"
        except:
            pass

    # 2. Analisa o nome do arquivo de forma estrita quebrando por partes
    nome_upper = os.path.basename(nome_arquivo).upper()
    
    # Se começar com 'F_' ou tiver termos femininos explícitos
    if nome_upper.startswith("F_") or "MULHER" in nome_upper:
        return "MULHER"
    if nome_upper.startswith("M_") or "HOMEM" in nome_upper:
        return "HOMEM"

    partes = re.split(r'[ _.-]', nome_upper)
    for parte in partes:
        if parte in NOMES_FEMININOS:
            return "MULHER"
            
    return "HOMEM"

def extrair_cnh(nome_arquivo):
    nome_upper = nome_arquivo.upper()
    if '_A' in nome_upper or 'MOTOS' in nome_upper or 'CNH_A' in nome_upper:
        return 'A'
    if '_B' in nome_upper or 'CARRO' in nome_upper or 'CNH_B' in nome_upper:
        return 'B'
    
    match = re.search(r'_([A-Z])\.jpg$', nome_upper)
    return match.group(1) if match else 'B'

vendidos_cache = None
vendidos_timestamp = None

def carregar_vendidos():
    global vendidos_cache, vendidos_timestamp
    if vendidos_cache and vendidos_timestamp and time.time() - vendidos_timestamp < 300:
        return vendidos_cache
    
    vendidos_set = set()
    if os.path.exists(VENDIDOS_FILE):
        try:
            with open(VENDIDOS_FILE, 'r', encoding='utf-8') as f:
                dados = json.load(f)
                for v in dados:
                    if caminho := v.get('caminho', ''):
                        vendidos_set.add(os.path.abspath(caminho))
                    if movido_para := v.get('movido_para', ''):
                        vendidos_set.add(os.path.abspath(movido_para))
        except:
            pass
    
    if os.path.exists(REPROVADOS_PATH):
        try:
            for file in os.listdir(REPROVADOS_PATH):
                if file.lower().endswith(('.jpg', '.png')):
                    vendidos_set.add(os.path.abspath(os.path.join(REPROVADOS_PATH, file)))
        except:
            pass
    
    vendidos_cache = vendidos_set
    vendidos_timestamp = time.time()
    return vendidos_set

def get_encodings():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'rb') as f:
                dados_cache = pickle.load(f)
                if dados_cache and isinstance(next(iter(dados_cache.values())), dict):
                    if 'nome_arquivo' in next(iter(dados_cache.values())):
                        return dados_cache
        except:
            pass

    encodings = {}
    if not os.path.exists(DATASET_PATH):
        os.makedirs(DATASET_PATH, exist_ok=True)
        return encodings

    for file in os.listdir(DATASET_PATH):
        if file.lower().endswith(('.jpg', '.png')):
            caminho = os.path.join(DATASET_PATH, file)
            img = cv2.imread(caminho)
            if img is not None:
                faces = face_app.get(img)
                if faces:
                    encodings[os.path.abspath(caminho)] = {
                        'embedding': faces[0].normed_embedding,
                        'genero': detectar_genero(caminho, file),
                        'cnh': extrair_cnh(file),
                        'nome_arquivo': file,
                        'origem_path': caminho
                    }

    with open(CACHE_FILE, 'wb') as f:
        pickle.dump(encodings, f)
    return encodings

@app.route('/imagens/<path:filename>')
def servir_imagem(filename):
    diretorio = request.args.get('dir', DATASET_PATH)
    return send_from_directory('.', 'facial.html')

@app.route('/compare_protected', methods=['POST'])
def compare():
    try:
        categoria = request.headers.get('categoria', '').upper()
        
        filtro_genero = None
        filtro_cnh = None

        if 'HOMEM' in categoria:
            filtro_genero = 'HOMEM'
        elif 'MULHER' in categoria:
            filtro_genero = 'MULHER'

        if '_A' in categoria:
            filtro_cnh = 'A'
        elif '_B' in categoria:
            filtro_cnh = 'B'

        vendidos_set = carregar_vendidos()

        if 'foto' not in request.files:
            return jsonify({"error": "Nenhuma imagem de selfie enviada"}), 400

        file = request.files['foto']
        file_bytes = np.frombuffer(file.read(), np.uint8)
        img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"error": "Erro ao decodificar imagem"}), 400

        faces = face_app.get(img)
        if not faces:
            return jsonify({"resultados": []})

        emb = faces[0].normed_embedding
        dataset = get_encodings()

        bicos_extras = request.files.getlist('bicos')
        dataset_dinamico = dataset.copy()

        if bicos_extras:
            for bico_file in bicos_extras[:1000]:
                bico_bytes = np.frombuffer(bico_file.read(), np.uint8)
                bico_img = cv2.imdecode(bico_bytes, cv2.IMREAD_COLOR)
                if bico_img is not None:
                    bico_faces = face_app.get(bico_img)
                    if bico_faces:
                        nome_bico = bico_file.filename
                        dataset_dinamico[nome_bico] = {
                            'embedding': bico_faces[0].normed_embedding,
                            'genero': detectar_genero(bico_file.filename, nome_bico),
                            'cnh': extrair_cnh(nome_bico),
                            'nome_arquivo': nome_bico,
                            'origem_path': 'UPLOAD_TEMP'
                        }

        matches = []
        for chave, info in dataset_dinamico.items():
            abs_path = os.path.abspath(info.get('origem_path', chave))
            if abs_path in vendidos_set:
                continue

            # VALIDAÇÃO RIGOROSA DE GÊNERO (Bloqueia totalmente se divergir)
            if filtro_genero and info.get('genero') != filtro_genero:
                continue

            if filtro_cnh and info.get('cnh') != filtro_cnh:
                continue

            from numpy.linalg import norm
            similarity = float(np.dot(emb, info['embedding']) / (norm(emb) * norm(info['embedding'])))
            conf = min(99.9, similarity * 100 * 2.5)
            
            if conf > 10:
                matches.append({
                    "caminho": info.get('nome_arquivo', os.path.basename(chave)),
                    "caminho_absoluto": info.get('origem_path', chave),
                    "similaridade": round(conf, 2)
                })

        matches = sorted(matches, key=lambda x: x['similaridade'], reverse=True)[:100]
        return jsonify({"resultados": matches})

    except Exception as e:
        print(f"❌ Erro: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)