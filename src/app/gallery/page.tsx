"use client";

import React, { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  getDocs,
  orderBy,
  query,
} from "firebase/firestore";

type Asset = {
  id: string;
  title: string;
  niche?: string;
  imageUrl: string;
  created_at?: Date | null;
  prompt?: string;
  source?: string;
};

export default function GalleryPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterNiche, setFilterNiche] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  useEffect(() => {
    const load = async () => {
      try {
        const colRef = collection(db, "assets");
        const q = query(colRef, orderBy("created_at", "desc"));
        const snap = await getDocs(q);

        const list: Asset[] = snap.docs.map((doc) => {
          const data = doc.data() as any;
          let created: Date | null = null;
          if (data.created_at?.toDate) {
            created = data.created_at.toDate();
          } else if (data.created_at instanceof Date) {
            created = data.created_at;
          }

          return {
            id: doc.id,
            title: data.title ?? "Untitled",
            niche: data.niche ?? "",
            imageUrl: data.imageUrl,
            created_at: created,
            prompt: data.prompt ?? "",
            source: data.source ?? "",
          };
        });

        setAssets(list);
      } catch (err) {
        console.error("Failed to load assets:", err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const niches = useMemo(() => {
    const set = new Set<string>();
    assets.forEach((a) => {
      if (a.niche && a.niche.trim()) {
        set.add(a.niche.trim());
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [assets]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();

    return assets.filter((a) => {
      const matchesNiche =
        !filterNiche || a.niche === filterNiche;

      const haystack =
        (a.title || "") +
        " " +
        (a.prompt || "") +
        " " +
        (a.niche || "");

      const matchesSearch =
        !q || haystack.toLowerCase().includes(q);

      return matchesNiche && matchesSearch;
    });
  }, [assets, filterNiche, search]);

  if (loading) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Gallery</h1>
        <p>Loading assets…</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>Gallery</h1>
      <p style={{ color: "#9ca3af", marginBottom: 16 }}>
        Browse AI-generated designs and manually added assets. Use the
        filters below to drill into niches or search by name and prompt.
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ flex: "1 1 220px", minWidth: 220 }}>
          <label style={{ fontSize: "0.9rem" }}>
            Search
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title, niche, or prompt…"
              style={{
                marginTop: 4,
                width: "100%",
                padding: 8,
                borderRadius: 8,
                border: "1px solid #1f2937",
                background: "#020617",
                color: "#e5e7eb",
              }}
            />
          </label>
        </div>

        <div style={{ flex: "0 0 220px", minWidth: 220 }}>
          <label style={{ fontSize: "0.9rem" }}>
            Niche
            <select
              value={filterNiche}
              onChange={(e) => setFilterNiche(e.target.value)}
              style={{
                marginTop: 4,
                width: "100%",
                padding: 8,
                borderRadius: 8,
                border: "1px solid #1f2937",
                background: "#020617",
                color: "#e5e7eb",
              }}
            >
              <option value="">All niches</option>
              {niches.map((niche) => (
                <option key={niche} value={niche}>
                  {niche}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {filteredAssets.length === 0 && (
        <p>No assets match your filters.</p>
      )}

      {filteredAssets.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          {filteredAssets.map((asset) => (
            <div
              key={asset.id}
              style={{
                borderRadius: 12,
                border: "1px solid #1f2937",
                background: "#020617",
                padding: 12,
              }}
            >
              <div
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  borderRadius: 8,
                  overflow: "hidden",
                  marginBottom: 8,
                  background: "#111827",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {asset.imageUrl ? (
                  <img
                    src={asset.imageUrl}
                    alt={asset.title}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "#6b7280",
                    }}
                  >
                    No image
                  </span>
                )}
              </div>

              <h2
                style={{
                  margin: 0,
                  fontSize: "0.95rem",
                  marginBottom: 4,
                }}
              >
                {asset.title}
              </h2>

              {asset.niche && (
                <p
                  style={{
                    margin: 0,
                    fontSize: "0.8rem",
                    color: "#9ca3af",
                    marginBottom: 4,
                  }}
                >
                  {asset.niche}
                </p>
              )}

              {asset.created_at && (
                <p
                  style={{
                    margin: 0,
                    fontSize: "0.75rem",
                    color: "#6b7280",
                  }}
                >
                  {asset.created_at.toLocaleString()}
                </p>
              )}

              {asset.source && (
                <p
                  style={{
                    margin: "4px 0 0 0",
                    fontSize: "0.75rem",
                    color: "#6b7280",
                  }}
                >
                  Source: {asset.source}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
