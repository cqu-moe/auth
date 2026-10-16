ARG BASE=auth-school-browser:local
FROM ${BASE}
COPY e2e/school/start.sh e2e/school/chrome.sh /fixture/
COPY --from=school-fixture school.py /fixture/school.py
RUN openssl req -x509 -newkey rsa:2048 -nodes -keyout /fixture/key.pem -out /fixture/cert.pem -days 7 \
      -subj '/CN=AUTH-03 synthetic school' -addext 'subjectAltName=DNS:sso.cqu.edu.cn,DNS:my.cqu.edu.cn' \
    && openssl x509 -in /fixture/cert.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | openssl base64 -A > /fixture/spki
ENV CQU_CHROMIUM_EXECUTABLE=/fixture/chrome.sh
ARG RUN_ID
LABEL moe.cqu.auth-e2e.run=${RUN_ID}
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/fixture/start.sh"]
