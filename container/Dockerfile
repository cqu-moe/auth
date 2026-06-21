# CQU 浏览器登录器镜像。用 buildx --platform=linux/amd64 构建(CF Containers 仅跑 amd64)。
# 注: 不在此处写 `FROM --platform=linux/amd64`(会触发 docker lint 警告), 平台靠构建时 --platform 指定。
FROM python:3.12-slim

# Chromium 渲染所需最小系统库集合(实测可在 basic 1 GiB 限制下构建并渲染真实登录页)。
# tini: 轻量 init, 作 PID 1 收割孤儿/僵尸 —— 取票/探活反复起关临时 chromium, 其孤儿进程被
# reparent 到 PID 1; 若 PID 1 是 python(从不 waitpid), 僵尸会累积。tini 作 PID 1 转发信号并
# reap。Debian bookworm(python:3.12-slim 基底)包名 tini, 二进制装在 /usr/bin/tini(已据
# packages.debian.org bookworm filelist 核实)。
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && patchright install chromium

COPY server.py cqu_login.py qg_proxy.py cqu_ticket.py cqu_ticket_browser.py cqu_keepalive.py ./

EXPOSE 8080
# tini 作 PID 1(-- 后接真实命令): 转发信号 + reap 临时 chromium 的孤儿/僵尸进程。
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "server.py"]
