#!/bin/sh
set -eu
printf '\n127.0.0.1 sso.cqu.edu.cn my.cqu.edu.cn\n' >> /etc/hosts
python /fixture/school.py &
exec xvfb-run -a -s '-screen 0 1440x1000x24 -nolisten tcp' python /app/server.py
