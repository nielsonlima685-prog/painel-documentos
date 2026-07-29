#!/usr/bin/env bash

# Instala as dependências normalmente dentro do ambiente ativo do Render
pip install -r requirements.txt

# Inicia o worker facial em segundo plano
python worker_facial_final.py &

# Inicia o servidor Node.js principal
node server.js
