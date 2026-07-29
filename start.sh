#!/usr/bin/env bash

# 1. Instala as dependências globalmente usando --user para garantir acesso direto
pip install --user -r requirements.txt

# 2. Inicia o worker facial em segundo plano usando python (com as libs já disponíveis)
python worker_facial_final.py &

# 3. Inicia o servidor Node.js principal
node server.js
