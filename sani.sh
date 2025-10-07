#!/bin/bash
# Cores para o terminal (opcional)
PINK='\033[1;35m'
BLUE='\033[0;34m'
NOCOLOR='\033[0m'
while true; do
    printf "${PINK}ฅ^•ﻌ•^ฅ Auto reconexão para prevenção de quedas...\n\n"
    if [ "$1" = "cdg" ]; then
        printf "${BLUE}Iniciando bot...${NOCOLOR}\n"
        node start.js --code
    else
        printf "${BLUE}Iniciando bot...${NOCOLOR}\n"
        node start.js
    fi
    echo -e "\n${PINK}𝗥𝗘𝗜𝗡𝗜𝗖𝗜𝗔𝗡𝗗𝗢 ฅ^•ﻌ•^ฅ...${NOCOLOR}\n"
    sleep 3
done