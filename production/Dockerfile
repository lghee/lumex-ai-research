FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY engine/requirements.txt /app/engine/requirements.txt
RUN pip install --no-cache-dir -r /app/engine/requirements.txt
COPY engine/ /app/engine/
COPY server.py /app/server.py
COPY cloudflare_binance_capture.py /app/cloudflare_binance_capture.py
RUN python -c "import server; from cloudflare_binance_capture import collector; assert callable(server.probe_binance_public_handshake); assert callable(collector.ensure); assert callable(collector.peek); assert hasattr(server.Handler, 'do_POST')"
RUN useradd -u 10001 -M -s /usr/sbin/nologin lumex
USER lumex
EXPOSE 8080
CMD ["python", "-u", "server.py"]
