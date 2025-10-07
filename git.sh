#!/bin/bash

# Caminho do repositório local
REPO_DIR="/sdcard/bot1"

# URL do seu GitHub (substitua pelo seu)
GIT_URL="https://github.com/saniofc/bot.git"

# Mensagem de commit
COMMIT_MSG="Atualizando bot"

echo "Iniciando push para o GitHub..."

cd "$REPO_DIR" || exit

# Inicializa git se não tiver
git init

# Adiciona remoto (substitui se já existir)
git remote remove origin 2>/dev/null
git remote add origin "$GIT_URL"

# Adiciona tudo
git add .

# Commit
git commit -m "$COMMIT_MSG"

# Força push para master/main (substituindo tudo no GitHub)
git push -u origin master --force

echo "Push concluído com sucesso!"