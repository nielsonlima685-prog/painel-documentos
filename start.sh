#!/usr/bin/env bash
# Garante que as dependências python estão instaladas na inicialização
pip install -r requirements.txt

# Inicia o worker facial em segundo plano
python worker_facial_final.py &

# Inicia o servidor Node.js principal
node server.js
