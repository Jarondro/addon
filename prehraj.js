const axios = require("axios");
const fs = require("fs");
const config = require("./config");

const BASE_URL = "https://prehrajto.cz/api/v2";

// Mimic the Android app headers
const APP_HEADERS = {
    "User-Agent": "okhttp/4.9.0",
    "Accept": "application/json",
    "Content-Type": "application/json",
};

const TOKENS_FILE = "./tokens.json";

function loadTokens() {
    try {
        if (fs.existsSync(TOKENS_FILE)) {
            const t = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
            console.log("[Přehraj] Loaded saved tokens from disk");
            return t;
        }
    } catch(e) {}
    return {};
}

function saveTokens(access, refresh) {
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify({ access, refresh }, null, 2));
    } catch(e) {
        console.error("[Přehraj] Could not save tokens:", e.message);
    }
}

class PrehrajClient {
    constructor() {
        const saved = loadTokens();
        this.accessToken = saved.access || null;
        this.refreshToken = saved.refresh || null;
        this.tokenExp = this._decodeExp(this.accessToken);
        this.loginPromise = null;
        this.client = axios.create({ headers: APP_HEADERS });
    }

    async login() {
        console.log("[Přehraj] Logging in via app API...");

        const r = await this.client.post(`${BASE_URL}/users/login`, {
            email: config.PREHRAJ_EMAIL,
            password: config.PREHRAJ_PASSWORD,
        }, { validateStatus: s => s < 500 });

        console.log("[Přehraj] Login status:", r.status);

        // Tokens may be in body or set-cookie headers
        let accessToken = r.data?.payload?.data?.tokens?.access || r.data?.payload?.access_token || null;
        let refreshToken = r.data?.payload?.data?.tokens?.refresh || r.data?.payload?.refresh_token || null;

        // Also check set-cookie
        const setCookies = r.headers["set-cookie"] || [];
        for (const cookie of setCookies) {
            const atMatch = cookie.match(/^access_token=([^;]+)/);
            const rtMatch = cookie.match(/^refresh_token=([^;]+)/);
            if (atMatch && atMatch[1] !== "deleted") accessToken = atMatch[1];
            if (rtMatch && rtMatch[1] !== "deleted") refreshToken = rtMatch[1];
        }

        console.log("[Přehraj] access_token:", accessToken ? "FOUND" : "NOT FOUND");
        console.log("[Přehraj] refresh_token:", refreshToken ? "FOUND" : "NOT FOUND");

        if (!accessToken) {
            console.log("[Přehraj] Response body:", JSON.stringify(r.data).slice(0, 400));
            throw new Error("App API login failed, falling back to web login...");
        }

        this.accessToken = accessToken;
        if (refreshToken) this.refreshToken = refreshToken;
        this.tokenExp = this._decodeExp(accessToken);
        saveTokens(this.accessToken, this.refreshToken);
        console.log("[Přehraj] Login successful! Token exp:", new Date(this.tokenExp * 1000).toISOString());
    }

    async webLogin() {
        console.log("[Přehraj] Falling back to web login...");
        const webClient = axios.create({
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json",
            },
        });

        const cookies = {};

        const ingestCookies = (setCookieHeaders = []) => {
            for (const cookie of setCookieHeaders) {
                const [pair] = cookie.split(";");
                const eqIdx = pair.indexOf("=");
                const k = pair.slice(0, eqIdx).trim();
                const v = pair.slice(eqIdx + 1).trim();
                if (v && v !== "deleted") cookies[k] = v;
                else delete cookies[k];
            }
        };

        const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

        // Homepage
        const home = await webClient.get("https://prehrajto.cz/", {
            maxRedirects: 5,
            validateStatus: s => s < 500,
        });
        ingestCookies(home.headers["set-cookie"]);

        // Login POST
        const formData = new URLSearchParams();
        formData.append("email", config.PREHRAJ_EMAIL);
        formData.append("password", config.PREHRAJ_PASSWORD);
        formData.append("remember_login", "on");
        formData.append("_do", "loginDialog-login-loginForm-submit");

        const post = await webClient.post(
            "https://prehrajto.cz/?frm=loginDialog-login-loginForm",
            formData.toString(),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": cookieHeader(),
                    "Referer": "https://prehrajto.cz/",
                    "Origin": "https://prehrajto.cz",
                },
                maxRedirects: 0,
                validateStatus: s => s < 500,
            }
        );
        ingestCookies(post.headers["set-cookie"]);

        // Follow redirect if needed
        if (post.data && post.data.redirect) {
            const loc = post.data.redirect.startsWith("http")
                ? post.data.redirect
                : `https://prehrajto.cz${post.data.redirect}`;
            const redir = await webClient.get(loc, {
                headers: { "Cookie": cookieHeader() },
                maxRedirects: 5,
                validateStatus: s => s < 500,
            });
            ingestCookies(redir.headers["set-cookie"]);
        }

        const accessToken = cookies["access_token"];
        const refreshToken = cookies["refresh_token"];

        if (!accessToken) throw new Error("Web login also failed");

        this.accessToken = accessToken;
        if (refreshToken) this.refreshToken = refreshToken;
        this.tokenExp = this._decodeExp(accessToken);
        saveTokens(this.accessToken, this.refreshToken);
        console.log("[Přehraj] Web login successful!");
    }

    async tryRefresh() {
        if (!this.refreshToken) return await this._doLogin();

        console.log("[Přehraj] Refreshing token...");
        try {
            const r = await this.client.post(`${BASE_URL}/users/refresh-token`, {
                refreshToken: this.refreshToken,
            }, { validateStatus: s => s < 500 });

            const accessToken = r.data?.payload?.data?.tokens?.access || r.data?.payload?.access_token;
            const refreshToken = r.data?.payload?.data?.tokens?.refresh || r.data?.payload?.refresh_token;

            if (accessToken) {
                this.accessToken = accessToken;
                if (refreshToken) this.refreshToken = refreshToken;
                this.tokenExp = this._decodeExp(accessToken);
                saveTokens(this.accessToken, this.refreshToken);
                console.log("[Přehraj] Token refreshed via API!");
                return;
            }
        } catch (e) {
            console.log("[Přehraj] Refresh failed:", e.message);
        }

        await this._doLogin();
    }

    async _doLogin() {
        try {
            await this.login();
        } catch (e) {
            console.log("[Přehraj]", e.message);
            await this.webLogin();
        }
    }

    _decodeExp(token) {
        try {
            const payload = token.split(".")[1];
            const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
            return JSON.parse(Buffer.from(padded, "base64").toString()).exp;
        } catch (e) { return 0; }
    }

    async ensureAuth() {
        const now = Math.floor(Date.now() / 1000);
        if (!this.accessToken || now > this.tokenExp - 60) {
            if (!this.loginPromise) {
                this.loginPromise = this.tryRefresh().finally(() => { this.loginPromise = null; });
            }
            await this.loginPromise;
        }
    }

    authHeaders() {
        return { ...APP_HEADERS, "Authorization": `Bearer ${this.accessToken}` };
    }

    async search(phrase, page = 1) {
        await this.ensureAuth();
        const r = await this.client.get(`${BASE_URL}/videos/search`, {
            params: { phrase, page },
            headers: this.authHeaders(),
        });
        return r.data.payload;
    }

    async getVideo(videoId) {
        await this.ensureAuth();
        const r = await this.client.get(`${BASE_URL}/videos/${videoId}`, {
            headers: this.authHeaders(),
        });
        return r.data.payload.data;
    }

    async getMostWatched() {
        await this.ensureAuth();
        const r = await this.client.get(`${BASE_URL}/videos/most-watched`, {
            headers: this.authHeaders(),
        });
        return r.data.payload;
    }
}

module.exports = new PrehrajClient();
