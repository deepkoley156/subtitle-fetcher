const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function absoluteUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

function uniqueByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function vttToSrt(vttText) {
  let text = String(vttText || "").replace(/\r/g, "");
  text = text.replace(/^WEBVTT[^\n]*\n+/i, "");

  const blocks = text.split(/\n\n+/);
  let counter = 1;
  const output = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) continue;

    if (lines[0].startsWith("NOTE")) continue;
    if (lines[0].startsWith("STYLE")) continue;
    if (lines[0].startsWith("REGION")) continue;

    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) continue;

    const timeLine = lines[timeIndex].replace(/\.(\d{3})/g, ",$1");

    const textLines = lines
      .slice(timeIndex + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();

    if (!textLines) continue;

    output.push(String(counter++));
    output.push(timeLine);
    output.push(textLines);
    output.push("");
  }

  return output.join("\n");
}

function extractSubtitleCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const results = [];

  $("track").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;

    const kind = ($(el).attr("kind") || "").toLowerCase();
    const srclang = $(el).attr("srclang") || "";
    const label = $(el).attr("label") || "";

    if (
      kind === "subtitles" ||
      kind === "captions" ||
      /\.(vtt|srt)(\?|$)/i.test(src)
    ) {
      results.push({
        type: "track-tag",
        lang: srclang || label || "unknown",
        url: absoluteUrl(pageUrl, src)
      });
    }
  });

  const regexList = [
    /https?:\/\/[^\s"'<>]+?\.(vtt|srt)(\?[^\s"'<>]*)?/gi,
    /["']([^"']+?\.(?:vtt|srt)(?:\?[^"']*)?)["']/gi,
    /"subtitles?"\s*:\s*(\[[\s\S]*?\])/gi,
    /"captions?"\s*:\s*(\[[\s\S]*?\])/gi,
    /"textTracks?"\s*:\s*(\[[\s\S]*?\])/gi
  ];

  for (const re of regexList) {
    let match;
    while ((match = re.exec(html)) !== null) {
      const found = match[1] || match[0];
      if (!found) continue;

      if (/\.(vtt|srt)(\?|$)/i.test(found)) {
        const cleaned = found.replace(/^["']|["']$/g, "");
        const abs = cleaned.startsWith("http")
          ? cleaned
          : absoluteUrl(pageUrl, cleaned);

        results.push({
          type: "html-regex",
          lang: "unknown",
          url: abs
        });
      }
    }
  }

  return uniqueByUrl(results).filter((x) => x.url);
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "subtitle-fetcher" });
});

app.post("/api/find-subtitles", async (req, res) => {
  try {
    const { pageUrl } = req.body || {};

    if (!pageUrl) {
      return res.status(400).json({ error: "pageUrl required" });
    }

    let parsed;
    try {
      parsed = new URL(pageUrl);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "Only http/https URLs allowed" });
    }

    const response = await axios.get(pageUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SubtitleFetcher/1.0",
        "Accept-Language": "en-US,en;q=0.9,*;q=0.8"
      }
    });

    const html = response.data;
    const subtitles = extractSubtitleCandidates(html, pageUrl);

    return res.json({
      success: true,
      count: subtitles.length,
      subtitles
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to fetch page",
      details: error.message
    });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const { fileUrl, format } = req.query;

    if (!fileUrl) {
      return res.status(400).send("fileUrl required");
    }

    let parsed;
    try {
      parsed = new URL(fileUrl);
    } catch {
      return res.status(400).send("Invalid fileUrl");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).send("Only http/https URLs allowed");
    }

    const fileRes = await axios.get(fileUrl, {
      responseType: "text",
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 SubtitleFetcher/1.0"
      }
    });

    const text = fileRes.data || "";
    const isVtt = /\.vtt(\?|$)/i.test(fileUrl) || /^WEBVTT/m.test(text);

    if (format === "srt") {
      const srtText = isVtt ? vttToSrt(text) : text;
      res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="subtitle.srt"');
      return res.send(srtText);
    }

    const ext = isVtt ? "vtt" : "srt";
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="subtitle.${ext}"`);
    return res.send(text);
  } catch (error) {
    return res.status(500).send("Failed to download subtitle");
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
