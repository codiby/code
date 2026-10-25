#!/usr/bin/env python3
"""Compile the real iOS REST client on macOS and check its HTTP contract in isolation."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from threading import Thread
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
requests = []


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == '/sessions'
        assert self.headers.get('Authorization') == 'Bearer share-test-token'
        body = json.dumps([
            {'id': 'share session/one', 'name': 'Test', 'cwd': '/test/mobile', 'status': 'open', 'updated_at': 2},
            {'id': 'closed', 'name': 'Closed', 'status': 'closed'},
            {'id': 'other', 'name': 'Other', 'status': 'open'},
        ]).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append((self.path, self.headers.get('Authorization'), body))
        self.send_response(503 if body['text'] == 'fail once' else 200)
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='codiby-ios-share-') as directory:
        binary = str(Path(directory) / 'share-tests')
        subprocess.run([
            'xcrun', 'swiftc', '-parse-as-library',
            'ios/ShareSupport/ShareConfig.swift', 'ios/ShareSupport/ShareClient.swift',
            'ios/ShareSupportTests/ShareClientTests.swift', '-o', binary,
        ], cwd=root, check=True)
        subprocess.run([binary], check=True, env={
            **os.environ, 'SHARE_TEST_URL': f'http://127.0.0.1:{server.server_port}',
        })
    assert len(requests) == 2, 'A failed POST must not retry automatically'
    for path, auth, body in requests:
        assert path == '/sessions/share%20session%2Fone/messages'
        assert auth == 'Bearer share-test-token'
        assert body['images'] == [{'media_type': 'image/jpeg', 'data': 'aW1hZ2U='}]
    print('PASS: POST payload, URI encoding, auth and no automatic retry on failure.')
finally:
    server.shutdown()
    server.server_close()
