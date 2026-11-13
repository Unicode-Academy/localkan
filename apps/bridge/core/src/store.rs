//! Local SQLite store: project/card runtime state and full agent logs.
//! Logs live only on this machine; the server never stores them.

use crate::protocol::LogLine;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS kv (
               kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
               PRIMARY KEY (kind, id));
             CREATE TABLE IF NOT EXISTS logs (
               card_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL,
               source TEXT NOT NULL, text TEXT NOT NULL,
               PRIMARY KEY (card_id, seq));",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn put<T: Serialize>(&self, kind: &str, id: &str, value: &T) -> Result<()> {
        let json = serde_json::to_string(value)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO kv (kind, id, json) VALUES (?1, ?2, ?3)
             ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json",
            params![kind, id, json],
        )?;
        Ok(())
    }

    pub fn get<T: DeserializeOwned>(&self, kind: &str, id: &str) -> Result<Option<T>> {
        let json: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT json FROM kv WHERE kind = ?1 AND id = ?2", params![kind, id], |r| r.get(0))
            .optional()?;
        Ok(match json {
            Some(j) => Some(serde_json::from_str(&j)?),
            None => None,
        })
    }

    pub fn all<T: DeserializeOwned>(&self, kind: &str) -> Result<Vec<T>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT json FROM kv WHERE kind = ?1")?;
        let rows = stmt.query_map(params![kind], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for j in rows {
            if let Ok(v) = serde_json::from_str(&j?) {
                out.push(v);
            }
        }
        Ok(out)
    }

    pub fn append_logs(&self, card_id: &str, lines: &[LogLine]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for l in lines {
            tx.execute(
                "INSERT OR REPLACE INTO logs (card_id, seq, ts, source, text) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![card_id, l.seq, l.ts, l.source, l.text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn logs_after(&self, card_id: &str, after: i64, limit: i64) -> Result<Vec<LogLine>> {
        let conn = self.conn.lock().unwrap();
        // Newest `limit` lines after `after`, returned oldest first.
        let mut stmt = conn.prepare(
            "SELECT seq, ts, source, text FROM (
               SELECT * FROM logs WHERE card_id = ?1 AND seq > ?2 ORDER BY seq DESC LIMIT ?3
             ) ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![card_id, after, limit], |r| {
            Ok(LogLine { seq: r.get(0)?, ts: r.get(1)?, source: r.get(2)?, text: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn last_seq(&self, card_id: &str) -> i64 {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT COALESCE(MAX(seq), -1) FROM logs WHERE card_id = ?1", params![card_id], |r| r.get(0))
            .unwrap_or(-1)
    }
}
