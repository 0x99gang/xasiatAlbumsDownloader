import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://www.xasiat.com";
const BLOCK_ID = "list_albums_albums_list_search_result";

const axiosInstance = axios.create({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: BASE_URL,
  },
  timeout: 30000,
});

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim().substring(0, 200);
}

function extractAlbumLinks(html: string): string[] {
  const re = /href="(https:\/\/www\.xasiat\.com\/albums\/\d+\/[^"]*)"/g;
  const urls: string[] = [];
  let match;
  while ((match = re.exec(html)) !== null) {
    urls.push(match[1]);
  }
  return [...new Set(urls)];
}

function extractAlbumNames(html: string): string[] {
  const $ = cheerio.load(html);
  const names: string[] = [];
  $("#list_albums_albums_list_search_result_items .item a[href*='/albums/'] strong.title").each((_, el) => {
    names.push($(el).text().trim());
  });
  return names;
}

async function fetchSearchPage(keyword: string, page: number): Promise<string> {
  const encoded = encodeURIComponent(keyword);
  if (page === 1) {
    const resp = await axiosInstance.get(`${BASE_URL}/search/${encoded}/`);
    return resp.data;
  }
  const params = new URLSearchParams();
  params.append("mode", "async");
  params.append("function", "get_block");
  params.append("block_id", BLOCK_ID);
  params.append("q", keyword);
  params.append("category_ids", "");
  params.append("sort_by", "");
  params.append("from_videos", String(page));
  params.append("from_albums", String(page));
  const resp = await axiosInstance.get(
    `${BASE_URL}/search/${encoded}/?${params.toString()}`,
    { headers: { "X-Requested-With": "XMLHttpRequest" } }
  );
  return resp.data;
}

async function fetchAllAlbumUrls(keyword: string): Promise<string[]> {
  const allUrls: string[] = [];
  let page = 1;

  while (true) {
    console.log(`  Fetching search page ${page}...`);
    const html = await fetchSearchPage(keyword, page);
    const urls = extractAlbumLinks(html);
    if (urls.length === 0) break;

    if (page > 1) {
      const names = extractAlbumNames(html);
      const keywordInNames = names.some((n) => n.includes(keyword));
      if (!keywordInNames) {
        console.log(`  No albums matching "${keyword}" on page ${page}, stopping pagination.`);
        break;
      }
    }

    allUrls.push(...urls);
    page++;
  }

  return [...new Set(allUrls)];
}

async function fetchAlbumImages(albumUrl: string): Promise<{ imageUrls: string[]; albumName: string }> {
  const resp = await axiosInstance.get(albumUrl);
  const $ = cheerio.load(resp.data);

  const albumName = $("h1").first().text().trim() || `album_${albumUrl.split("/").filter(Boolean).pop() || "unknown"}`;

  const imageUrls: string[] = [];
  $('.album-holder .images a.item[rel="images"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) imageUrls.push(href);
  });

  return { imageUrls, albumName };
}

async function downloadImage(url: string, filePath: string): Promise<void> {
  const resp = await axiosInstance.get(url, { responseType: "arraybuffer" });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, resp.data);
}

async function downloadAlbum(albumUrl: string, keyword: string, outputDir: string, delayMs: number = 2000): Promise<void> {
  const { imageUrls, albumName } = await fetchAlbumImages(albumUrl);
  if (imageUrls.length === 0) {
    console.log(`  No images found.`);
    return;
  }

  if (!albumName.includes(keyword)) {
    console.log(`  Skipped (name doesn't match keyword): ${albumName}`);
    return;
  }

  const folderName = sanitizeFilename(albumName);
  const albumDir = path.join(outputDir, folderName);

  console.log(`  Album: ${albumName} (${imageUrls.length} images)`);

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const ext = path.extname(new URL(url).pathname) || ".jpg";
    const fileName = `${String(i + 1).padStart(3, "0")}${ext}`;
    const filePath = path.join(albumDir, fileName);

    if (fs.existsSync(filePath)) {
      console.log(`    [${i + 1}/${imageUrls.length}] Exists`);
      continue;
    }

    try {
      await downloadImage(url, filePath);
      console.log(`    [${i + 1}/${imageUrls.length}] Downloaded`);
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      console.error(`    [${i + 1}/${imageUrls.length}] Failed: ${(err as Error).message}`);
    }
  }
}

function showHelp(): void {
  console.log(`
xasiat-albums-downloader - Download photo albums from xasiat.com

USAGE:
  xasiat-downloader <keyword> [options]

ARGUMENTS:
  keyword                  Search keyword (e.g. model name in Japanese/English)

OPTIONS:
  --delay <ms>             Delay between image downloads in ms (default: 2000)
  --limit <count>          Max number of albums to download (default: all)
  --output <dir>           Output directory (default: ./downloads)
  --help, -h               Show this help message

EXAMPLES:
  xasiat-downloader 石川澪
  xasiat-downloader "Mio Ishikawa" --limit 3
  xasiat-downloader 鈴村あいり --delay 1000 --output ./photos
  xasiat-downloader --help
`);
}

function parseArgs(): { keyword: string; delay: number; limit: number; output: string; help: boolean } {
  const args = process.argv.slice(2);
  let keyword = "";
  let delay = 2000;
  let limit = Infinity;
  let output = "downloads";
  let help = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--delay":
        delay = parseInt(args[++i], 10) || 2000;
        break;
      case "--limit":
        limit = parseInt(args[++i], 10) || Infinity;
        break;
      case "--output":
        output = args[++i] || "downloads";
        break;
      default:
        if (!keyword) keyword = args[i];
    }
  }

  return { keyword, delay, limit, output, help };
}

async function main() {
  const opts = parseArgs();

  if (opts.help || !opts.keyword) {
    showHelp();
    process.exit(opts.help ? 0 : 1);
  }

  const baseDir = path.resolve(process.cwd(), opts.output);
  const outputDir = path.join(baseDir, sanitizeFilename(opts.keyword));
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`Searching albums for: ${opts.keyword}`);
  const albumUrls = await fetchAllAlbumUrls(opts.keyword);
  const urls = opts.limit < albumUrls.length ? albumUrls.slice(0, opts.limit) : albumUrls;
  console.log(`Found ${albumUrls.length} album(s), downloading ${urls.length}.`);

  for (let i = 0; i < urls.length; i++) {
    console.log(`\n[${i + 1}/${urls.length}] ${urls[i]}`);
    try {
      await downloadAlbum(urls[i], opts.keyword, outputDir, opts.delay);
    } catch (err) {
      console.error(`  Failed: ${(err as Error).message}`);
    }
  }

  console.log("\nDone!");
}

main().catch(console.error);
