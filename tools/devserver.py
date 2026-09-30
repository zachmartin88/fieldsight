"""Local dev server: serves the app with caching turned off so edits always show up."""
import http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
http.server.ThreadingHTTPServer(('', port), NoCache).serve_forever()
