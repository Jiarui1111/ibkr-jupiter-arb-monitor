import { tokenIds, tokenMap, conidMap } from './config.js';
import https from 'https';
import client from 'prom-client';
import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const jobName = 'stock_monitor';

const channel = process.env.SLACK_CHANNEL;
const token = process.env.SLACK_BOT_TOKEN;
const spread = 0.02;
const ALERT_INTERVAL = 60 * 1000;

const ibPriceCache = {};
const alertCache = new Map();

const clean = (val) => {
    if (typeof val !== 'string') return undefined;
    const num = parseFloat(val.replace(/[^\d.-]/g, ''));
    return isNaN(num) ? undefined : num;
};

function startIBKRWebSocket(conids, fields = ['31', '84', '86'], retryDelay = 5000) {
    const streamUrl = 'wss://132.232.141.173:5001/v1/api/ws';
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    let ws;

    const connect = () => {
        console.log('Connecting to IBKR WebSocket...');
        ws = new WebSocket(streamUrl, { agent: httpsAgent });

        ws.on('open', () => {
            console.log('✅ IBKR WebSocket connected');
            setTimeout(() => {
                for (const conid of conids) {
                    const msg = `smd+${conid}+${JSON.stringify({ fields })}`;
                    ws.send(msg);
                }
            }, 1000);
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                const conid = msg.conid;
                if (!conid) return;

                const last = clean(msg["31"]);
                const bid = clean(msg["84"]);
                const ask = clean(msg["86"]);

                ibPriceCache[conid] = { last, bid, ask };

            } catch (e) {
                console.error('❌ WS Parse error:', e.message);
            }
        });

        ws.on('close', () => {
            console.warn('🔌 WebSocket closed. Reconnecting in', retryDelay / 1000, 's...');
            reconnect();
        });

        ws.on('error', (err) => {
            console.error('⚠️ WebSocket error:', err.message);
            ws.close(); 
        });
    };

    const reconnect = () => {
        setTimeout(() => {
            connect();
        }, retryDelay);
    };

    connect();
}


async function pushGateway(prices) {
    const register = new client.Registry();
    const gateway = new client.Pushgateway(
        "https://pushgateway.csiodev.com/a38dcd952899d8e2",
        [],
        register
    );

    const onchainMetric = new client.Gauge({
        name: `stock_onchain_price_ws`,
        help: `On-chain stock prices（From Jupiter）`,
        labelNames: ["tokenId"],
        registers: [register],
    });

    const offchainMetric = new client.Gauge({
        name: `stock_offchain_price_ws`,
        help: `Off-chain stock prices（From IBKR）`,
        labelNames: ["tokenId"],
        registers: [register],
    });

    const spreadMetric = new client.Gauge({
        name: `stock_price_spread_ws`,
        help: `The difference between off-chain and on-chain prices（IB - Jupiter）`,
        labelNames: ["tokenId"],
        registers: [register],
    });

    for (const item of prices) {
        const { tokenId, onChainPrice, ibPrice } = item;
        const symbol = tokenMap[tokenId];

        if (onChainPrice !== undefined) {
            onchainMetric.set({ tokenId: symbol }, onChainPrice);
        }
        if (ibPrice !== undefined) {
            offchainMetric.set({ tokenId: symbol }, ibPrice);
        }
        if (onChainPrice !== undefined && ibPrice !== undefined) {
            const spread = onChainPrice / ibPrice - 1;
            spreadMetric.set({ tokenId: symbol }, spread);
        }
    }

    await _pushgateway(gateway);
    console.log('📤 Successfully pushed to PushGateway ✅');
}

async function _pushgateway(gateway) {
    return new Promise((resolve) => {
        const request = async () => {
            try {
                await gateway.push({ jobName });
                resolve();
            } catch (error) {
                console.error(`Error push gateway(retry): ${error}`);
                setTimeout(request, 3000);
            }
        };
        request();
    });
}

function getIBPricesFromCache(conidList) {
    const result = {};
    for (const conid of conidList) {
        if (ibPriceCache[conid]) {
            result[conid] = { ...ibPriceCache[conid] };
        }
    }
    return result;
}


async function getPricesAndPush() {
    const jupiterUrl = "https://lite-api.jup.ag/price/v3";
    const params = new URLSearchParams({ ids: tokenIds.join(',') });

    try {
        const jupiterRes = await fetch(`${jupiterUrl}?${params}`);
        const jupiterData = await jupiterRes.json();

        const conidList = tokenIds.map((id) => conidMap[id]);
        const ibPriceMap = await getIBPricesFromCache(conidList);

        const prices = [];
        for (const tokenId of tokenIds) {
            const onChainPrice = parseFloat(jupiterData[tokenId]?.usdPrice);
            const conId = conidMap[tokenId];
            const ibPrice = ibPriceMap[conId]?.last;
            const ibBid = ibPriceMap[conId]?.bid; //84买
            const ibAsk = ibPriceMap[conId]?.ask; //86卖

            if (!isNaN(onChainPrice) && !isNaN(ibPrice)) {
                prices.push({ tokenId, onChainPrice, ibPrice });

                const spreadOffchain = ibBid && onChainPrice ? ibBid / onChainPrice - 1 : null;

                const spreadOnchain = ibAsk && onChainPrice ? onChainPrice / ibAsk - 1 : null;

                if (spreadOffchain !== null && spreadOffchain >= spread) {
                    const message = `[套利机会-链上⬇️ 链下⬆️] 
Token: ${tokenMap[tokenId]} | 
链上: $${onChainPrice} | 
bid1: $${ibBid} |
spread: $${(spreadOffchain * 100).toFixed(2)}%`;
                    logAndNotify(tokenMap[tokenId], message);
                }

                if (spreadOnchain !== null && spreadOnchain >= spread) {
                    const message = `[套利机会-链上⬆️ 链下⬇️]
Token: ${tokenMap[tokenId]} | 
链上: $${onChainPrice} | 
ask1: $${ibAsk} |
spread: $${(spreadOnchain * 100).toFixed(2)}% `;
                    logAndNotify(tokenMap[tokenId], message);
                }

                console.log(`🪙 ${tokenMap[tokenId]} (${tokenId})`);
                console.log(`  - On-chain Jupiter: $${onChainPrice.toFixed(2)}`);
                console.log(`  - Off-chain IB: $${ibPrice.toFixed(2)}`);
            }
        }
        await pushGateway(prices);
    } catch (error) {
        console.error(`Data fetching or pushing failed: ${error.message}`);
    }
}

async function main() {
    startIBKRWebSocket(tokenIds.map(id => conidMap[id]));
    while (true) {
        await getPricesAndPush();
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
}

function logAndNotify(conid, message) {
    const now = Date.now();
    const lastTime = alertCache.get(conid) || 0;

    if (now - lastTime < ALERT_INTERVAL) {
        return; 
    }

    alertCache.set(conid, now);

    console.log(message);
    const url = 'https://slack.com/api/chat.postMessage';

    axios.post(url, {
        channel,
        "text": message
    }, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    })
        .catch(err => { })
}

main();
