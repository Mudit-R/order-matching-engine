package com.engine.server;

import com.engine.core.LimitOrderBook;
import com.engine.core.MatchingEngine;
import com.engine.model.Level2Snapshot;
import com.engine.model.OrderType;
import com.engine.model.Side;
import com.engine.model.Trade;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

public class MatchingEngineServer {
    private static final int PORT = 8080;
    private static final MatchingEngine engine = new MatchingEngine(MatchingEngineServer::broadcastTrade);
    private static final AtomicLong orderIdGen = new AtomicLong(1000);
    private static final List<Trade> recentTrades = new CopyOnWriteArrayList<>();

    private static void broadcastTrade(Trade trade) {
        recentTrades.add(0, trade);
        if (recentTrades.size() > 50) {
            recentTrades.remove(recentTrades.size() - 1);
        }
    }

    public static void main(String[] args) throws IOException {
        engine.registerSymbol("NIFTY50");
        engine.registerSymbol("BANKNIFTY");
        engine.registerSymbol("RELIANCE");
        engine.start();

        // Seed initial market depth
        seedInitialBook("NIFTY50", 19500);
        seedInitialBook("BANKNIFTY", 44200);
        seedInitialBook("RELIANCE", 25000);

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        // API endpoints
        server.createContext("/api/snapshot", MatchingEngineServer::handleSnapshot);
        server.createContext("/api/order", MatchingEngineServer::handleOrder);
        server.createContext("/api/trades", MatchingEngineServer::handleTrades);
        server.createContext("/api/stats", MatchingEngineServer::handleStats);
        server.createContext("/", MatchingEngineServer::handleStaticFiles);

        server.start();
        System.out.println("==========================================================");
        System.out.println(" 🚀 High-Throughput Matching Engine Server Active!");
        System.out.println(" Web Dashboard & Depth Ladder: http://localhost:" + PORT);
        System.out.println("==========================================================");
    }

    private static void seedInitialBook(String symbol, long midPrice) {
        LimitOrderBook book = engine.getBook(symbol);
        if (book == null) return;

        for (int i = 1; i <= 8; i++) {
            long bidPrice = midPrice - (i * 20);
            long askPrice = midPrice + (i * 20);
            book.addOrder(orderIdGen.incrementAndGet(), Side.BUY, OrderType.LIMIT, bidPrice, 50 * i, System.nanoTime());
            book.addOrder(orderIdGen.incrementAndGet(), Side.SELL, OrderType.LIMIT, askPrice, 40 * i, System.nanoTime());
        }
    }

    private static void handleSnapshot(HttpExchange exchange) throws IOException {
        String query = exchange.getRequestURI().getQuery();
        String symbol = "NIFTY50";
        if (query != null && query.contains("symbol=")) {
            symbol = query.split("symbol=")[1].split("&")[0];
        }

        LimitOrderBook book = engine.getBook(symbol);
        if (book == null) {
            sendResponse(exchange, 404, "{\"error\":\"Symbol not found\"}");
            return;
        }

        Level2Snapshot snap = book.getLevel2Snapshot(12);
        StringBuilder json = new StringBuilder();
        json.append("{\"symbol\":\"").append(snap.symbol).append("\",\"timestamp\":").append(snap.timestampNs);
        json.append(",\"spread\":").append(book.getSpread());
        json.append(",\"best_bid\":").append(book.getBestBid());
        json.append(",\"best_ask\":").append(book.getBestAsk());
        json.append(",\"bids\":[");
        for (int i = 0; i < snap.bids.size(); i++) {
            if (i > 0) json.append(",");
            Level2Snapshot.LevelEntry e = snap.bids.get(i);
            json.append(String.format("{\"price\":%d,\"qty\":%d,\"orders\":%d}", e.price, e.totalQuantity, e.orderCount));
        }
        json.append("],\"asks\":[");
        for (int i = 0; i < snap.asks.size(); i++) {
            if (i > 0) json.append(",");
            Level2Snapshot.LevelEntry e = snap.asks.get(i);
            json.append(String.format("{\"price\":%d,\"qty\":%d,\"orders\":%d}", e.price, e.totalQuantity, e.orderCount));
        }
        json.append("]}");

        sendResponse(exchange, 200, json.toString());
    }

    private static void handleOrder(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendResponse(exchange, 405, "{\"error\":\"Method not allowed\"}");
            return;
        }

        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        try {
            // Minimal zero-dependency JSON parser
            String symbol = extractJsonField(body, "symbol", "NIFTY50");
            String sideStr = extractJsonField(body, "side", "BUY");
            String typeStr = extractJsonField(body, "type", "LIMIT");
            long price = Long.parseLong(extractJsonField(body, "price", "0"));
            int qty = Integer.parseInt(extractJsonField(body, "qty", "100"));

            Side side = Side.valueOf(sideStr.toUpperCase());
            OrderType type = OrderType.valueOf(typeStr.toUpperCase());
            long orderId = orderIdGen.incrementAndGet();

            boolean queued = engine.submitCommand(new MatchingEngine.Command(
                    MatchingEngine.Command.Action.NEW, orderId, symbol, side, type, price, qty));

            sendResponse(exchange, 200, String.format("{\"success\":%b,\"order_id\":%d}", queued, orderId));
        } catch (Exception e) {
            sendResponse(exchange, 400, "{\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    private static void handleTrades(HttpExchange exchange) throws IOException {
        StringBuilder json = new StringBuilder("[");
        int count = 0;
        for (Trade t : recentTrades) {
            if (count++ > 0) json.append(",");
            json.append(String.format("{\"maker\":%d,\"taker\":%d,\"price\":%d,\"qty\":%d,\"side\":\"%s\",\"ts\":%d}",
                    t.makerOrderId, t.takerOrderId, t.price, t.quantity, t.takerSide, t.timestampNs));
        }
        json.append("]");
        sendResponse(exchange, 200, json.toString());
    }

    private static void handleStats(HttpExchange exchange) throws IOException {
        String json = String.format("{\"processed_orders\":%d,\"executed_trades\":%d}",
                engine.processedOrders.get(), engine.executedTrades.get());
        sendResponse(exchange, 200, json);
    }

    private static void handleStaticFiles(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if ("/".equals(path)) path = "/index.html";

        File file = new File("web_dashboard" + path);
        if (!file.exists()) {
            // Try relative to workspace
            file = new File("../web_dashboard" + path);
        }

        if (file.exists() && !file.isDirectory()) {
            String mime = path.endsWith(".html") ? "text/html" :
                          path.endsWith(".css") ? "text/css" :
                          path.endsWith(".js") ? "application/javascript" : "text/plain";
            byte[] bytes = java.nio.file.Files.readAllBytes(file.toPath());
            exchange.getResponseHeaders().set("Content-Type", mime);
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(bytes);
            }
        } else {
            sendResponse(exchange, 404, "File Not Found");
        }
    }

    private static void sendResponse(HttpExchange exchange, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static String extractJsonField(String json, String field, String defaultVal) {
        String pattern = "\"" + field + "\"\\s*:\\s*\"?([^,\"}]+)\"?";
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(pattern).matcher(json);
        if (matcher.find()) {
            return matcher.group(1).trim();
        }
        return defaultVal;
    }
}
