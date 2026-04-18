#!/usr/bin/env python3
"""
Pokemon Release Notifier
Checks multiple sources for new Pokemon game/product announcements
and sends email notifications with the details.
"""

import hashlib
import json
import logging
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import requests
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration (all secrets come from environment variables)
# ---------------------------------------------------------------------------
EMAIL_SENDER = os.environ.get("EMAIL_SENDER", "")
EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")  # App password
EMAIL_RECIPIENT = os.environ.get("EMAIL_RECIPIENT", "")
SMTP_SERVER = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))

# File that stores hashes of already-seen announcements so we don't re-alert
SEEN_FILE = Path(os.environ.get("SEEN_FILE", "pokemon-notifier/seen.json"))

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

REQUEST_TIMEOUT = 20


# ---------------------------------------------------------------------------
# Source scrapers – each returns a list of dicts:
#   {"title": str, "url": str, "source": str, "summary": str}
# ---------------------------------------------------------------------------


def fetch_pokemon_com():
    """Scrape the official Pokemon Company news page."""
    results = []
    url = "https://www.pokemon.com/us/pokemon-news"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        articles = soup.select("li.p-news-list__item, article, .news-list__item")[:10]
        for art in articles:
            link_tag = art.find("a", href=True)
            title_tag = art.find(["h2", "h3", "h4", "span"])
            if not link_tag:
                continue
            href = link_tag["href"]
            if not href.startswith("http"):
                href = "https://www.pokemon.com" + href
            title = title_tag.get_text(strip=True) if title_tag else link_tag.get_text(strip=True)
            summary_tag = art.find("p")
            summary = summary_tag.get_text(strip=True) if summary_tag else ""
            if _is_release_related(title + " " + summary):
                results.append({
                    "title": title,
                    "url": href,
                    "source": "Pokemon.com",
                    "summary": summary[:300],
                })
    except Exception as exc:
        log.warning("Failed to fetch pokemon.com: %s", exc)
    return results


def fetch_serebii():
    """Check Serebii.net front page for news."""
    results = []
    url = "https://www.serebii.net/"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        # Serebii uses <h2> tags for news headlines on the main page
        headlines = soup.find_all("h2")[:15]
        for h in headlines:
            text = h.get_text(strip=True)
            parent_link = h.find_parent("a", href=True)
            link = parent_link["href"] if parent_link else url
            if not link.startswith("http"):
                link = "https://www.serebii.net/" + link.lstrip("/")
            # Grab sibling paragraph for summary
            sibling = h.find_next_sibling("p")
            summary = sibling.get_text(strip=True)[:300] if sibling else ""
            if _is_release_related(text + " " + summary):
                results.append({
                    "title": text,
                    "url": link,
                    "source": "Serebii.net",
                    "summary": summary,
                })
    except Exception as exc:
        log.warning("Failed to fetch serebii.net: %s", exc)
    return results


def fetch_pokemondb():
    """Check PokemonDB news page."""
    results = []
    url = "https://pokemondb.net/news"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        articles = soup.select("article, .news-article, .grid-col")[:10]
        for art in articles:
            link_tag = art.find("a", href=True)
            title_tag = art.find(["h2", "h3"])
            if not link_tag:
                continue
            href = link_tag["href"]
            if not href.startswith("http"):
                href = "https://pokemondb.net" + href
            title = title_tag.get_text(strip=True) if title_tag else link_tag.get_text(strip=True)
            summary_tag = art.find("p")
            summary = summary_tag.get_text(strip=True) if summary_tag else ""
            if _is_release_related(title + " " + summary):
                results.append({
                    "title": title,
                    "url": href,
                    "source": "PokemonDB",
                    "summary": summary[:300],
                })
    except Exception as exc:
        log.warning("Failed to fetch pokemondb.net: %s", exc)
    return results


def fetch_reddit():
    """Check r/pokemon and r/PokemonSwordAndShield for release announcements."""
    results = []
    subreddits = ["pokemon", "NintendoSwitch", "PokemonScarletViolet"]
    for sub in subreddits:
        url = f"https://www.reddit.com/r/{sub}/search.json"
        params = {
            "q": "new pokemon game OR pokemon release OR pokemon announcement OR pokemon reveal",
            "sort": "new",
            "restrict_sr": "on",
            "t": "week",
            "limit": 10,
        }
        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
            posts = data.get("data", {}).get("children", [])
            for post in posts:
                d = post.get("data", {})
                title = d.get("title", "")
                permalink = d.get("permalink", "")
                selftext = d.get("selftext", "")[:300]
                link = f"https://www.reddit.com{permalink}" if permalink else ""
                score = d.get("score", 0)
                # Only include posts with some traction
                if score >= 20 and _is_release_related(title + " " + selftext):
                    results.append({
                        "title": f"[r/{sub}] {title}",
                        "url": link,
                        "source": f"Reddit r/{sub}",
                        "summary": selftext[:300],
                    })
        except Exception as exc:
            log.warning("Failed to fetch Reddit r/%s: %s", sub, exc)
    return results


def fetch_twitter_nitter():
    """
    Check Pokemon-related X/Twitter accounts via public Nitter instances.
    Falls back gracefully if Nitter instances are down.
    """
    results = []
    accounts = ["Pokemon", "NintendoAmerica", "SerebiiNet"]
    nitter_instances = [
        "https://nitter.privacydev.net",
        "https://nitter.poast.org",
    ]
    for account in accounts:
        fetched = False
        for instance in nitter_instances:
            if fetched:
                break
            url = f"{instance}/{account}/rss"
            try:
                resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, "xml")
                items = soup.find_all("item")[:10]
                for item in items:
                    title = item.find("title")
                    link = item.find("link")
                    desc = item.find("description")
                    title_text = title.get_text(strip=True) if title else ""
                    link_text = link.get_text(strip=True) if link else ""
                    desc_text = desc.get_text(strip=True)[:300] if desc else ""
                    if _is_release_related(title_text + " " + desc_text):
                        results.append({
                            "title": f"[@{account}] {title_text[:120]}",
                            "url": link_text,
                            "source": f"X/Twitter @{account}",
                            "summary": desc_text,
                        })
                fetched = True
            except Exception as exc:
                log.warning("Nitter %s failed for @%s: %s", instance, account, exc)
    return results


# ---------------------------------------------------------------------------
# Keyword matching
# ---------------------------------------------------------------------------

RELEASE_KEYWORDS = [
    "new game", "new pokemon game", "release date", "announced", "announcement",
    "reveal", "revealed", "trailer", "coming soon", "launch", "pre-order",
    "preorder", "new generation", "gen 10", "gen 11", "legends", "remake",
    "new title", "pokemon presents", "direct", "dlc", "expansion",
    "new region", "starter", "starters revealed", "release window",
    "pokemon drop", "new pokemon drop", "tcg set", "new set",
    "new expansion", "scarlet", "violet", "new entry", "sequel",
]


def _is_release_related(text: str) -> bool:
    """Return True if the text appears to be about a new Pokemon release/drop."""
    lower = text.lower()
    return any(kw in lower for kw in RELEASE_KEYWORDS)


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------


def _load_seen() -> set:
    if SEEN_FILE.exists():
        try:
            return set(json.loads(SEEN_FILE.read_text()))
        except Exception:
            return set()
    return set()


def _save_seen(seen: set):
    SEEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    SEEN_FILE.write_text(json.dumps(sorted(seen)))


def _item_hash(item: dict) -> str:
    raw = f"{item['source']}|{item['title']}|{item['url']}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def filter_new(items: list[dict]) -> list[dict]:
    """Remove items we've already notified about."""
    seen = _load_seen()
    new_items = []
    for item in items:
        h = _item_hash(item)
        if h not in seen:
            new_items.append(item)
            seen.add(h)
    _save_seen(seen)
    return new_items


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------


def send_email(items: list[dict]):
    """Send an HTML email summarising new Pokemon release news."""
    if not all([EMAIL_SENDER, EMAIL_PASSWORD, EMAIL_RECIPIENT]):
        log.error(
            "Email not configured. Set EMAIL_SENDER, EMAIL_PASSWORD, "
            "and EMAIL_RECIPIENT environment variables."
        )
        sys.exit(1)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    subject = f"Pokemon Release Alert - {len(items)} new item(s) - {now}"

    rows = ""
    for item in items:
        rows += f"""
        <tr>
            <td style="padding:10px;border-bottom:1px solid #eee;">
                <strong><a href="{item['url']}">{item['title']}</a></strong><br>
                <small style="color:#888;">Source: {item['source']}</small><br>
                <p style="margin:5px 0;">{item['summary']}</p>
            </td>
        </tr>"""

    html = f"""\
    <html>
    <body style="font-family:Arial,sans-serif;max-width:700px;margin:auto;">
        <h2 style="color:#E3350D;">New Pokemon Release News!</h2>
        <p>Found <strong>{len(items)}</strong> new item(s) as of {now}.</p>
        <table style="width:100%;border-collapse:collapse;">
            {rows}
        </table>
        <hr>
        <p style="font-size:12px;color:#999;">
            Pokemon Release Notifier &mdash; automated alert
        </p>
    </body>
    </html>"""

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = EMAIL_SENDER
    msg["To"] = EMAIL_RECIPIENT
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(EMAIL_SENDER, EMAIL_PASSWORD)
            server.sendmail(EMAIL_SENDER, EMAIL_RECIPIENT, msg.as_string())
        log.info("Email sent to %s with %d items.", EMAIL_RECIPIENT, len(items))
    except Exception as exc:
        log.error("Failed to send email: %s", exc)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    log.info("Pokemon Release Notifier starting...")

    all_items = []
    # Run all scrapers
    scrapers = [
        ("Pokemon.com", fetch_pokemon_com),
        ("Serebii.net", fetch_serebii),
        ("PokemonDB", fetch_pokemondb),
        ("Reddit", fetch_reddit),
        ("X/Twitter", fetch_twitter_nitter),
    ]

    for name, scraper in scrapers:
        log.info("Checking %s...", name)
        try:
            items = scraper()
            log.info("  Found %d release-related item(s) from %s", len(items), name)
            all_items.extend(items)
        except Exception as exc:
            log.warning("  Scraper %s failed: %s", name, exc)

    log.info("Total items found: %d", len(all_items))

    # Deduplicate against previously seen items
    new_items = filter_new(all_items)
    log.info("New (unseen) items: %d", len(new_items))

    if new_items:
        send_email(new_items)
    else:
        log.info("No new Pokemon release news. No email sent.")

    log.info("Done.")


if __name__ == "__main__":
    main()
