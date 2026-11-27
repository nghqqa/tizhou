#!/usr/bin/env python3
"""题舟官网流量与下载转化率线上私有看板服务（零第三方依赖，兼容 Python 3.6+）。

通过 Nginx 反向代理暴露于 https://tizhou.nghqqa.cn/stats?key=<STATS_KEY>：
- 仅监听 127.0.0.1（默认端口 8782），不对外暴露端口；
- 校验 ?key= / X-Stats-Key / __Host-tizhou_stats Cookie（常量时间比对），未授权一律返回 404；
- 实时读取 /var/log/nginx/tizhou-website.access.log*（含 .gz 历史轮转日志），只返回聚合计数，绝不泄露原始访客 IP。
"""
import base64
import datetime
import glob
import gzip
import hmac
import html
import json
import os
import re
import secrets
import socketserver
import threading
import time
import urllib.parse
import urllib.request
from http import cookies as http_cookies
from http.server import BaseHTTPRequestHandler, HTTPServer

OWN_HOST = "tizhou.nghqqa.cn"
GITHUB_REPO = "nghqqa/tizhou"
COOKIE_NAME_HTTPS = "__Host-tizhou_stats"
COOKIE_NAME_HTTP = "tizhou_stats_key"

MONTH_MAP = {
    "Jan": "01",
    "Feb": "02",
    "Mar": "03",
    "Apr": "04",
    "May": "05",
    "Jun": "06",
    "Jul": "07",
    "Aug": "08",
    "Sep": "09",
    "Oct": "10",
    "Nov": "11",
    "Dec": "12",
}

LOG_LINE_RE = re.compile(
    r'^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)\s+[^"]+"\s+(\d{3})\s+(\d+|-)\s+"([^"]*)"\s+"([^"]*)"(?:\s+"([^"]*)")?'
)
TIME_DATE_RE = re.compile(r"^(\d{2})/([A-Za-z]{3})/(\d{4}):")
BOT_UA_RE = re.compile(
    r"^(?:node(?:/|$)|python|curl|wget|go-http-client)|bot\b|spider|crawler|slurp|bingpreview|mediapartners|adsbot|headless|playwright|puppeteer|phantomjs|curl/|wget/|python-requests|python-urllib|go-http-client|java/|okhttp|libwww|scrapy|httpclient|node-fetch|undici|axios/|censys|zgrab|shodan|nuclei|masscan|nmap|ahrefs|semrush|mj12bot|dotbot|bytespider|petalbot|yandex|baiduspider|sogou|360spider|yisouspider|googlebot|bingbot|duckduckbot|applebot|facebookexternalhit|twitterbot|whatsapp|telegrambot|slackbot|discordbot|dnspod-monitor|uptimerobot|pingdom|statuscake|monitor",
    re.IGNORECASE,
)
PRIVATE_IP_RE = re.compile(
    r"^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd)", re.IGNORECASE
)
SOURCE_TAG_RE = re.compile(r"^[a-zA-Z0-9_-]{1,32}$")

_github_lock = threading.Lock()
_github_cache = {"expires_at": 0.0, "data": None}


def is_likely_bot(user_agent):
    ua = (user_agent or "").strip()
    if not ua or ua == "-":
        return True
    return bool(BOT_UA_RE.search(ua))


def _resolve_client_ip(remote_addr, forwarded_for):
    if forwarded_for and forwarded_for != "-" and PRIVATE_IP_RE.search(remote_addr):
        first = forwarded_for.split(",")[0].strip()
        if first and first != "-":
            return first
    return remote_addr


def _extract_source_tag(search):
    if not search:
        return ""
    params = urllib.parse.parse_qs(search, keep_blank_values=False)
    raw = ""
    if "from" in params and params["from"]:
        raw = params["from"][0].strip()
    elif "utm_source" in params and params["utm_source"]:
        raw = params["utm_source"][0].strip()
    return raw if SOURCE_TAG_RE.match(raw) else ""


def _extract_referer_host(referer):
    if not referer or referer == "-":
        return ""
    try:
        parsed = urllib.parse.urlparse(referer)
        return (parsed.hostname or "").lower()
    except Exception:
        return ""


def parse_nginx_log_line(line):
    match = LOG_LINE_RE.match(line or "")
    if not match:
        return None
    remote_addr, time_local, method, raw_target, status_raw, _, referer, user_agent, xff = (
        match.groups()
    )
    tm = TIME_DATE_RE.match(time_local)
    if not tm:
        return None
    day, mon_abbr, year = tm.groups()
    month = MONTH_MAP.get(mon_abbr)
    if not month:
        return None
    date_key = "{}-{}-{}".format(year, month, day)

    q_idx = raw_target.find("?")
    pathname = raw_target[:q_idx] if q_idx >= 0 else raw_target
    search = raw_target[q_idx + 1 :] if q_idx >= 0 else ""

    return {
        "ip": _resolve_client_ip(remote_addr, xff or ""),
        "dateKey": date_key,
        "method": method,
        "pathname": pathname,
        "sourceTag": _extract_source_tag(search),
        "status": int(status_raw),
        "refererHost": _extract_referer_host(referer),
        "userAgent": user_agent,
        "isBot": is_likely_bot(user_agent),
    }


def _classify_event(entry):
    if entry["method"] != "GET":
        return None
    path = entry["pathname"]
    status = entry["status"]
    if path in ("/", "/index.html") and status in (200, 304):
        return "home"
    if 300 <= status < 400:
        if path == "/go/download-cnb":
            return "download-cnb"
        if path == "/go/download-github":
            return "download-github"
        if path == "/go/releases-cnb":
            return "releases-cnb"
        if path in ("/go/checksum-cnb", "/go/checksum-github"):
            return "checksum"
    return None


def _ratio_pct(numerator, denominator):
    if not denominator:
        return None
    return round((numerator / float(denominator)) * 100.0, 1)


def _today_key():
    return datetime.datetime.now().strftime("%Y-%m-%d")


def _min_date_key(today_key, days):
    if days <= 0:
        return ""
    dt = datetime.datetime.strptime(today_key, "%Y-%m-%d").date()
    return (dt - datetime.timedelta(days=days - 1)).strftime("%Y-%m-%d")


def aggregate_website_stats(lines, days=14, include_bots=False, today_key=None):
    today = today_key or _today_key()
    min_date = _min_date_key(today, days)

    total_lines = 0
    parsed_lines = 0
    bot_filtered = 0

    home_ips = set()
    dl_ips = set()
    dl_cnb_ips = set()
    dl_gh_ips = set()

    home_pv = 0
    dl_cnb_pv = 0
    dl_gh_pv = 0
    releases_cnb_pv = 0
    checksum_pv = 0

    daily_map = {}
    channel_map = {}
    referer_map = {}

    for raw in lines:
        if not raw or not raw.strip():
            continue
        total_lines += 1
        entry = parse_nginx_log_line(raw)
        if not entry:
            continue
        parsed_lines += 1
        if min_date and entry["dateKey"] < min_date:
            continue

        kind = _classify_event(entry)
        if not kind:
            continue

        if not include_bots and entry["isBot"]:
            bot_filtered += 1
            continue

        dk = entry["dateKey"]
        day_bucket = daily_map.get(dk)
        if day_bucket is None:
            day_bucket = {
                "dateKey": dk,
                "homePv": 0,
                "homeIps": set(),
                "downloadCnbPv": 0,
                "downloadGithubPv": 0,
                "downloadIps": set(),
            }
            daily_map[dk] = day_bucket

        ip = entry["ip"]
        tag = entry["sourceTag"]

        if kind == "home":
            home_pv += 1
            home_ips.add(ip)
            day_bucket["homePv"] += 1
            day_bucket["homeIps"].add(ip)
            if tag:
                ch = channel_map.setdefault(
                    tag, {"tag": tag, "homePv": 0, "homeIps": set(), "downloadPv": 0, "downloadIps": set()}
                )
                ch["homePv"] += 1
                ch["homeIps"].add(ip)
            ref_host = entry["refererHost"]
            ref_label = "(直接访问 / 站内)" if (not ref_host or ref_host == OWN_HOST) else ref_host
            ref = referer_map.setdefault(ref_label, {"host": ref_label, "homePv": 0, "homeIps": set()})
            ref["homePv"] += 1
            ref["homeIps"].add(ip)
        elif kind in ("download-cnb", "download-github"):
            if kind == "download-cnb":
                dl_cnb_pv += 1
                dl_cnb_ips.add(ip)
                day_bucket["downloadCnbPv"] += 1
            else:
                dl_gh_pv += 1
                dl_gh_ips.add(ip)
                day_bucket["downloadGithubPv"] += 1
            dl_ips.add(ip)
            day_bucket["downloadIps"].add(ip)
            if tag:
                ch = channel_map.setdefault(
                    tag, {"tag": tag, "homePv": 0, "homeIps": set(), "downloadPv": 0, "downloadIps": set()}
                )
                ch["downloadPv"] += 1
                ch["downloadIps"].add(ip)
        elif kind == "releases-cnb":
            releases_cnb_pv += 1
        elif kind == "checksum":
            checksum_pv += 1

    dl_total_pv = dl_cnb_pv + dl_gh_pv
    daily = []
    for dk in sorted(daily_map.keys()):
        d = daily_map[dk]
        daily.append(
            {
                "date": dk,
                "homePv": d["homePv"],
                "homeUv": len(d["homeIps"]),
                "downloadCnbPv": d["downloadCnbPv"],
                "downloadGithubPv": d["downloadGithubPv"],
                "downloadTotalPv": d["downloadCnbPv"] + d["downloadGithubPv"],
                "downloadUv": len(d["downloadIps"]),
                "conversionUvPct": _ratio_pct(len(d["downloadIps"]), len(d["homeIps"])),
            }
        )

    channels = []
    for ch in sorted(
        channel_map.values(),
        key=lambda item: (-len(item["downloadIps"]), -len(item["homeIps"]), item["tag"]),
    ):
        channels.append(
            {
                "tag": ch["tag"],
                "homePv": ch["homePv"],
                "homeUv": len(ch["homeIps"]),
                "downloadPv": ch["downloadPv"],
                "downloadUv": len(ch["downloadIps"]),
                "conversionUvPct": _ratio_pct(len(ch["downloadIps"]), len(ch["homeIps"])),
            }
        )

    referers = []
    for ref in sorted(
        referer_map.values(),
        key=lambda item: (-len(item["homeIps"]), -item["homePv"], item["host"]),
    )[:12]:
        referers.append(
            {
                "host": ref["host"],
                "homePv": ref["homePv"],
                "homeUv": len(ref["homeIps"]),
            }
        )

    return {
        "windowDays": days,
        "fromDate": min_date or "全部",
        "toDate": today,
        "includeBots": include_bots,
        "totalLines": total_lines,
        "parsedLines": parsed_lines,
        "botEventsFiltered": bot_filtered,
        "summary": {
            "homePv": home_pv,
            "homeUv": len(home_ips),
            "downloadCnbPv": dl_cnb_pv,
            "downloadCnbUv": len(dl_cnb_ips),
            "downloadGithubPv": dl_gh_pv,
            "downloadGithubUv": len(dl_gh_ips),
            "downloadTotalPv": dl_total_pv,
            "downloadTotalUv": len(dl_ips),
            "releasesCnbPv": releases_cnb_pv,
            "checksumPv": checksum_pv,
            "conversionUvPct": _ratio_pct(len(dl_ips), len(home_ips)),
            "conversionPvPct": _ratio_pct(dl_total_pv, home_pv),
        },
        "daily": daily,
        "channels": channels,
        "referers": referers,
    }


def iter_access_log_lines(log_prefix):
    gz_files = sorted(glob.glob("{}-*.gz".format(log_prefix)))
    plain_rotated = sorted(
        f for f in glob.glob("{}-*".format(log_prefix)) if not f.endswith(".gz")
    )
    all_files = gz_files + plain_rotated
    if os.path.isfile(log_prefix):
        all_files.append(log_prefix)

    for path in all_files:
        try:
            if path.endswith(".gz"):
                with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        yield line
            else:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        yield line
        except OSError:
            continue


def fetch_github_release_summary(force_refresh=False):
    now = time.time()
    with _github_lock:
        if not force_refresh and _github_cache["expires_at"] > now:
            return _github_cache["data"]

    data = None
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/{}/releases?per_page=100".format(GITHUB_REPO),
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "tizhou-stats-server/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            releases = json.loads(resp.read().decode("utf-8"))
        total_exe = 0
        recent = []
        for rel in releases:
            cnt = sum(
                int(a.get("download_count") or 0)
                for a in (rel.get("assets") or [])
                if str(a.get("name") or "").endswith(".exe")
            )
            total_exe += cnt
            if len(recent) < 5:
                recent.append({"tag": rel.get("tag_name", ""), "downloads": cnt})
        data = {"releaseCount": len(releases), "totalExe": total_exe, "recent": recent}
    except Exception:
        with _github_lock:
            return _github_cache["data"]

    with _github_lock:
        _github_cache["data"] = data
        _github_cache["expires_at"] = now + 300.0
    return data


def render_dashboard_html(template_text, nonce, initial_days=14, initial_include_bots=False):
    return (
        template_text.replace("__CSP_NONCE__", html.escape(nonce, quote=True))
        .replace("__SOURCE_LABEL__", "服务器实时日志")
        .replace("__BADGE_TEXT__", "密钥鉴权 · 仅聚合计数")
        .replace("__API_BASE__", "/stats/api")
        .replace("__INITIAL_DAYS__", str(max(0, int(initial_days))))
        .replace("__INITIAL_INCLUDE_BOTS__", "true" if initial_include_bots else "false")
    )


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def create_handler(stats_key, log_prefix, template_path):
    with open(template_path, "r", encoding="utf-8") as fh:
        template_text = fh.read()

    class StatsRequestHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # 禁止把带 ?key= 的请求路径打印到 journalctl
            return

        def _set_common_headers(self):
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("X-Robots-Tag", "noindex, nofollow")
            self.send_header("Cache-Control", "no-store")

        def _send_json(self, status, payload, extra_headers=None):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._set_common_headers()
            if extra_headers:
                for k, v in extra_headers:
                    self.send_header(k, v)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_not_found(self):
            body = b"Not Found\n"
            self.send_response(404)
            self._set_common_headers()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _is_https_request(self):
            proto = (self.headers.get("X-Forwarded-Proto") or "").lower()
            return proto == "https"

        def _extract_cookie_key(self):
            raw = self.headers.get("Cookie")
            if not raw:
                return ""
            jar = http_cookies.SimpleCookie()
            try:
                jar.load(raw)
            except Exception:
                return ""
            for name in (COOKIE_NAME_HTTPS, COOKIE_NAME_HTTP):
                if name in jar:
                    return jar[name].value
            return ""

        def _authorize(self, query_params):
            candidates = []
            if "key" in query_params and query_params["key"]:
                candidates.append(("query", query_params["key"][0]))
            header_key = (self.headers.get("X-Stats-Key") or "").strip()
            if header_key:
                candidates.append(("header", header_key))
            cookie_key = self._extract_cookie_key()
            if cookie_key:
                candidates.append(("cookie", cookie_key))

            for source, value in candidates:
                if value and hmac.compare_digest(value, stats_key):
                    return source
            return None

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            pathname = parsed.path.rstrip("/") or "/"
            params = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)

            auth_source = self._authorize(params)
            if not auth_source:
                self._send_not_found()
                return

            if pathname in ("/stats", "/"):
                days = 14
                if "days" in params and params["days"] and params["days"][0].isdigit():
                    days = int(params["days"][0])
                include_bots = params.get("includeBots", ["0"])[0] == "1"
                nonce = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
                csp = "; ".join(
                    [
                        "script-src 'nonce-{}' 'strict-dynamic' 'report-sample'".format(nonce),
                        "object-src 'none'",
                        "base-uri 'none'",
                        "frame-ancestors 'none'",
                    ]
                )
                body = render_dashboard_html(
                    template_text,
                    nonce=nonce,
                    initial_days=days,
                    initial_include_bots=include_bots,
                ).encode("utf-8")
                self.send_response(200)
                self._set_common_headers()
                self.send_header("Content-Security-Policy", csp)
                if auth_source == "query":
                    if self._is_https_request():
                        self.send_header(
                            "Set-Cookie",
                            "{}={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000".format(
                                COOKIE_NAME_HTTPS, stats_key
                            ),
                        )
                    else:
                        self.send_header(
                            "Set-Cookie",
                            "{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000".format(
                                COOKIE_NAME_HTTP, stats_key
                            ),
                        )
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if pathname in ("/stats/api", "/api/stats"):
                extra = [("Vary", "Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site")]
                fetch_site = (self.headers.get("Sec-Fetch-Site") or "").lower()
                if fetch_site and fetch_site not in ("same-origin", "none"):
                    self._send_json(403, {"error": "Forbidden cross-site request"}, extra)
                    return
                days = 14
                if "days" in params and params["days"] and params["days"][0].isdigit():
                    days = int(params["days"][0])
                include_bots = params.get("includeBots", ["0"])[0] == "1"
                force_refresh = params.get("refresh", ["0"])[0] == "1"

                stats = aggregate_website_stats(
                    iter_access_log_lines(log_prefix),
                    days=days,
                    include_bots=include_bots,
                )
                gh = fetch_github_release_summary(force_refresh=force_refresh)
                payload = {
                    "stats": stats,
                    "githubReleases": gh,
                    "fetchedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "sourceLabel": "服务器实时日志",
                    "cached": False,
                }
                self._send_json(200, payload, extra)
                return

            self._send_not_found()

    return StatsRequestHandler


def main():
    stats_key = os.environ.get("STATS_KEY", "").strip()
    if len(stats_key) < 16:
        raise SystemExit("STATS_KEY 环境变量缺失或长度不足 16 位，拒绝启动")
    host = os.environ.get("STATS_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.environ.get("STATS_PORT", "8782"))
    log_prefix = os.environ.get("STATS_LOG_PREFIX", "/var/log/nginx/tizhou-website.access.log")
    template_path = os.environ.get(
        "STATS_TEMPLATE_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "stats-dashboard.html"),
    )
    handler = create_handler(stats_key, log_prefix, template_path)
    server = ThreadingHTTPServer((host, port), handler)
    print("[tizhou-stats] listening on http://{}:{}".format(host, port), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
