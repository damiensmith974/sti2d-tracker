/* ============================================================================
 * SUIVI DES COMPÉTENCES STI2D — Couche de synchronisation Supabase
 * ============================================================================
 * PRINCIPE "DROP-IN" : ce fichier se charge APRÈS le script principal du HTML
 * et ne demande AUCUNE modification du code existant, à part 2 balises <script>.
 *
 *  - Au démarrage : écran de connexion INDIVIDUEL (1 compte par prof),
 *    lecture de l'état sur Supabase, remplacement du contenu de `state`,
 *    re-rendu de l'interface. La session est mémorisée (localStorage) :
 *    chaque prof ne saisit son mot de passe qu'une fois par navigateur.
 *  - Ensuite : `saveState()` (appelé partout dans l'appli) est enveloppé pour
 *    continuer à écrire dans localStorage (cache hors-ligne) ET pousser vers
 *    Supabase, de façon différentielle (seules les lignes modifiées partent).
 *  - Temps réel : toute modification faite par un autre prof est reçue,
 *    appliquée au `state` local et l'interface se re-rend automatiquement.
 *  - Migration : si la base est vide, la migration du localStorage est
 *    proposée automatiquement. On peut aussi lancer STI2D.migrate() en console.
 *
 * INSTALLATION (2 lignes à ajouter juste avant </body> dans le HTML) :
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="supabase-sync.js"></script>
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * 1) CONFIGURATION
   *    Supabase > Project Settings > API :
   *      - Project URL  -> SUPABASE_URL
   *      - anon public  -> SUPABASE_ANON_KEY
   *    Les 4 comptes profs doivent exister dans Supabase > Authentication >
   *    Users (voir supabase/create_users.sql ou la doc de déploiement).
   * ========================================================================*/
  const SUPABASE_URL = "https://zkggtmcxiuzcwlffigro.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InprZ2d0bWN4aXV6Y3dsZmZpZ3JvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2Mzg4MDEsImV4cCI6MjA5OTIxNDgwMX0.vtbVL-jEA5EM0ybiG9ZSTjR01OejBADjHCdDhfj01As";

  // Les 4 profs : email de connexion -> nom affiché dans l'interface
  const TEACHERS = {
    "damien.smith@ac-reunion.fr":        "SMITH",
    "pierre-yves.huraux@ac-reunion.fr":  "HURAUX",
    "davy.thiaw-woaye@ac-reunion.fr":    "THIAW-WOAYE",
    "christopher.nativel@ac-reunion.fr": "NATIVEL",
  };

  /* ==========================================================================
   * 2) INITIALISATION DU CLIENT
   * ========================================================================*/
  if (typeof supabase === "undefined") {
    console.error("[STI2D] Librairie supabase-js absente : ajouter la balise " +
      '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> AVANT ce fichier.');
    return;
  }
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /* ==========================================================================
   * 3) CORRESPONDANCE  state <-> tables
   *    Chaque entrée décrit : la table, sa clé primaire, et la conversion
   *    objet-du-state <-> ligne SQL (camelCase <-> snake_case).
   * ========================================================================*/
  const CHUNK = 400; // taille des paquets d'upsert (6700 progressions ≈ 17 requêtes)

  const TABLES = {
    competencies: {
      table: "competencies", pk: ["code"],
      toRow: c => ({ code: c.code, label: c.label }),
      fromRow: r => ({ code: r.code, label: r.label }),
    },
    students: {
      table: "students", pk: ["name"],
      toRow: s => ({ name: s.name, level: s.level, group_name: s.group || null }),
      fromRow: r => ({ name: r.name, level: r.level, group: r.group_name }),
    },
    ganttItems: {
      table: "gantt_items", pk: ["id"],
      toRow: g => ({ id: g.id, row_name: g.row, label: g.label || null, title: g.title || null,
                     start_week: g.startWeek, duration: g.duration, kind: g.kind || "sequence" }),
      fromRow: r => ({ id: r.id, row: r.row_name, label: r.label, title: r.title,
                       startWeek: r.start_week, duration: r.duration, kind: r.kind }),
    },
    sequences: {
      table: "sequences", pk: ["id"],
      // assigned_teachers (jsonb) : profs qui font la séquence, ex ["SMITH","HURAUX"]
      toRow: s => ({ id: s.id, title: s.title, ref: s.ref || null, level: s.level || null,
                     track: s.track || null, competencies: s.competencies || [],
                     assigned_teachers: s.assignedTeachers || [] }),
      fromRow: r => ({ id: r.id, title: r.title, ref: r.ref, level: r.level,
                       track: r.track, competencies: r.competencies || [],
                       assignedTeachers: r.assigned_teachers || [] }),
    },
    itProjects: {
      table: "it_projects", pk: ["id"],
      toRow: p => ({ id: p.id, title: p.title, problem: p.problem || null, mei: p.mei || null,
                     level: p.level || null, track: p.track || null, competencies: p.competencies || [] }),
      fromRow: r => ({ id: r.id, title: r.title, problem: r.problem, mei: r.mei,
                       level: r.level, track: r.track, competencies: r.competencies || [] }),
    },
    progressions: {
      table: "progressions", pk: ["student_name", "competency_code", "item_id"],
      toRow: p => ({ student_name: p.student, competency_code: p.competencyCode,
                     item_id: p.itemId, status: p.status }),
      fromRow: r => ({ student: r.student_name, competencyCode: r.competency_code,
                       itemId: r.item_id, status: r.status }),
    },
    manual: {
      table: "manual_evaluations", pk: ["student_name", "competency_code"],
      toRow: m => ({ student_name: m.student, competency_code: m.competencyCode,
                     status: m.status, score: (m.score != null ? m.score : null) }),
      fromRow: r => {
        const o = { student: r.student_name, competencyCode: r.competency_code, status: r.status };
        if (r.score != null) o.score = Number(r.score);
        return o;
      },
    },
    prefill: {
      table: "prefill", pk: ["student_name", "competency_code"],
      toRow: p => ({ student_name: p.student, competency_code: p.competencyCode,
                     group_name: p.group || null, level: p.level || null,
                     score: (p.score != null ? p.score : null), status: p.status || null }),
      fromRow: r => ({ student: r.student_name, group: r.group_name, level: r.level,
                       competencyCode: r.competency_code,
                       score: (r.score != null ? Number(r.score) : null), status: r.status }),
    },
  };

  // teacherPresence est un objet {itemId: [profs]} -> conversion spéciale en lignes
  function presenceToRows(tp) {
    const rows = [];
    Object.keys(tp || {}).forEach(id =>
      (tp[id] || []).forEach(t => rows.push({ item_id: id, teacher: t })));
    return rows;
  }
  function rowsToPresence(rows) {
    const tp = {};
    (rows || []).forEach(r => { (tp[r.item_id] = tp[r.item_id] || []).push(r.teacher); });
    return tp;
  }

  // Clés de configuration stockées dans la table `settings` (jsonb)
  const SETTINGS_KEYS = ["meta", "calendarConfig", "masteryScale", "ganttRows",
                         "firstOnlyCompetencies", "schedule", "studentProfiles"];

  // Ordre de poussée respectant les clés étrangères (parents d'abord)
  const PUSH_ORDER = ["competencies", "students", "ganttItems", "sequences",
                      "itProjects", "progressions", "manual", "prefill"];

  /* ==========================================================================
   * 4) AUTHENTIFICATION — login individuel par prof
   *    - Session mémorisée par supabase-js dans localStorage : le mot de
   *      passe n'est demandé qu'une fois par navigateur (ou après logout).
   *    - Un écran de connexion plein-écran est injecté PAR-DESSUS l'appli :
   *      index.html reste inchangé.
   * ========================================================================*/
  const LAST_EMAIL_KEY = "sti2d-last-email";
  let currentTeacher = null;

  function teacherNameOf(session) {
    const email = ((session && session.user && session.user.email) || "").toLowerCase();
    return TEACHERS[email] || email || "?";
  }

  function showLoginOverlay() {
    return new Promise(resolve => {
      const ov = document.createElement("div");
      ov.id = "sti2d-login";
      ov.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;" +
        "align-items:center;justify-content:center;background:#1f2937;" +
        "font-family:system-ui,sans-serif";
      const last = (localStorage.getItem(LAST_EMAIL_KEY) || "").toLowerCase();
      const options = Object.keys(TEACHERS).map(email =>
        '<option value="' + email + '"' + (email === last ? " selected" : "") + ">" +
        TEACHERS[email] + " — " + email + "</option>").join("");
      ov.innerHTML =
        '<form style="background:#fff;padding:28px 32px;border-radius:12px;' +
          'box-shadow:0 10px 40px rgba(0,0,0,.4);width:380px;max-width:92vw">' +
          '<h2 style="margin:0 0 4px;font-size:18px;color:#111827">Suivi des compétences STI2D</h2>' +
          '<p style="margin:0 0 18px;color:#6b7280;font-size:13px">Connexion enseignant</p>' +
          '<label style="font-size:13px;color:#374151">Enseignant</label>' +
          '<select id="sti2d-email" style="width:100%;box-sizing:border-box;margin:4px 0 12px;' +
            'padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px">' +
            options + "</select>" +
          '<label style="font-size:13px;color:#374151">Mot de passe</label>' +
          '<input id="sti2d-pwd" type="password" autocomplete="current-password" required ' +
            'style="width:100%;box-sizing:border-box;margin:4px 0 6px;padding:8px;' +
            'border:1px solid #d1d5db;border-radius:6px;font-size:14px">' +
          '<div id="sti2d-err" style="color:#c0392b;font-size:12px;min-height:16px;margin-bottom:8px"></div>' +
          '<button type="submit" style="width:100%;padding:10px;border:0;border-radius:6px;' +
            'background:#2563eb;color:#fff;font-size:15px;cursor:pointer">Se connecter</button>' +
        "</form>";
      document.body.appendChild(ov);
      ov.querySelector("#sti2d-pwd").focus();

      const form = ov.querySelector("form");
      const err = ov.querySelector("#sti2d-err");
      const btn = form.querySelector("button");
      form.addEventListener("submit", async ev => {
        ev.preventDefault();
        const email = ov.querySelector("#sti2d-email").value;
        const pwd = ov.querySelector("#sti2d-pwd").value;
        err.textContent = "";
        btn.disabled = true; btn.textContent = "Connexion…";
        const { data, error } = await sb.auth.signInWithPassword({ email, password: pwd });
        btn.disabled = false; btn.textContent = "Se connecter";
        if (error) {
          err.textContent = (error.message === "Invalid login credentials")
            ? "Email ou mot de passe incorrect." : "Échec : " + error.message;
          return;
        }
        localStorage.setItem(LAST_EMAIL_KEY, email);
        ov.remove();
        resolve(data.session);
      });
    });
  }

  async function ensureAuth() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) return session;          // session mémorisée -> pas de login
    return await showLoginOverlay();      // sinon : écran de connexion
  }

  // Petit bouton "prof connecté / déconnexion" en bas à gauche
  let logoutBtn;
  function showLogoutButton(session) {
    currentTeacher = teacherNameOf(session);
    if (!logoutBtn) {
      logoutBtn = document.createElement("button");
      logoutBtn.style.cssText = "position:fixed;bottom:8px;left:8px;z-index:9999;" +
        "padding:4px 10px;border-radius:12px;font:12px sans-serif;border:0;" +
        "background:#374151;color:#fff;opacity:.85;cursor:pointer";
      logoutBtn.title = "Se déconnecter";
      logoutBtn.addEventListener("click", async () => {
        if (!window.confirm("Se déconnecter (" + currentTeacher + ") ?")) return;
        await sb.auth.signOut();
        location.reload();
      });
      document.body.appendChild(logoutBtn);
    }
    logoutBtn.textContent = "👤 " + currentTeacher + " — déconnexion";
  }

  /* ==========================================================================
   * 5) LECTURE COMPLÈTE — assemble un objet au format exact du state
   * ========================================================================*/
  async function fetchAll(table, mapRow) {
    const out = [];
    for (let from = 0; ; from += 1000) {                 // pagination (>1000 lignes)
      const { data, error } = await sb.from(table).select("*").range(from, from + 999);
      if (error) throw new Error(table + " : " + error.message);
      out.push(...data.map(mapRow));
      if (data.length < 1000) break;
    }
    return out;
  }

  async function fetchRemoteState() {
    const remote = {};
    await Promise.all(Object.keys(TABLES).map(async key => {
      remote[key] = await fetchAll(TABLES[key].table, TABLES[key].fromRow);
    }));
    remote.teacherPresence = rowsToPresence(await fetchAll("teacher_presence", r => r));
    const { data: st, error } = await sb.from("settings").select("*");
    if (error) throw error;
    (st || []).forEach(r => { if (SETTINGS_KEYS.includes(r.key)) remote[r.key] = r.value; });
    return remote;
  }

  /* ==========================================================================
   * 6) ÉCRITURE DIFFÉRENTIELLE
   *    On garde un instantané de ce qui est en base (`snapshot`) ; à chaque
   *    saveState() on compare et on n'envoie que les lignes ajoutées /
   *    modifiées / supprimées. Léger et rapide, même avec 6700 progressions.
   * ========================================================================*/
  const snapshot = {};        // clé state -> Map(pk -> JSON de la ligne)
  const lastPushAt = {};      // table SQL -> timestamp (anti-écho realtime)

  function pkOf(row, pk) { return pk.map(k => row[k]).join(""); }
  function toMap(list, cfg) {
    const m = new Map();
    (list || []).forEach(item => { const r = cfg.toRow(item); m.set(pkOf(r, cfg.pk), JSON.stringify(r)); });
    return m;
  }

  async function pushTableDiff(key) {
    const cfg = TABLES[key];
    const current = toMap(state[key], cfg);
    const previous = snapshot[key] || new Map();
    const upserts = [], deletions = [];
    current.forEach((json, k) => { if (previous.get(k) !== json) upserts.push(JSON.parse(json)); });
    previous.forEach((json, k) => { if (!current.has(k)) deletions.push(JSON.parse(json)); });
    if (!upserts.length && !deletions.length) return false;

    lastPushAt[cfg.table] = Date.now();
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const { error } = await sb.from(cfg.table).upsert(upserts.slice(i, i + CHUNK));
      if (error) throw new Error(cfg.table + " upsert : " + error.message);
    }
    for (const row of deletions) {
      let q = sb.from(cfg.table).delete();
      cfg.pk.forEach(k => { q = q.eq(k, row[k]); });
      const { error } = await q;
      if (error) throw new Error(cfg.table + " delete : " + error.message);
    }
    snapshot[key] = current;
    lastPushAt[cfg.table] = Date.now();
    return true;
  }

  async function pushPresenceDiff() {
    const rows = presenceToRows(state.teacherPresence);
    const cfg = { pk: ["item_id", "teacher"], toRow: r => r };
    const current = toMap(rows, cfg);
    const previous = snapshot.teacherPresence || new Map();
    const upserts = [], deletions = [];
    current.forEach((json, k) => { if (!previous.has(k)) upserts.push(JSON.parse(json)); });
    previous.forEach((json, k) => { if (!current.has(k)) deletions.push(JSON.parse(json)); });
    if (!upserts.length && !deletions.length) return false;
    lastPushAt["teacher_presence"] = Date.now();
    if (upserts.length) {
      const { error } = await sb.from("teacher_presence").upsert(upserts);
      if (error) throw new Error("teacher_presence : " + error.message);
    }
    for (const row of deletions) {
      const { error } = await sb.from("teacher_presence").delete()
        .eq("item_id", row.item_id).eq("teacher", row.teacher);
      if (error) throw new Error("teacher_presence : " + error.message);
    }
    snapshot.teacherPresence = current;
    lastPushAt["teacher_presence"] = Date.now();
    return true;
  }

  async function pushSettingsDiff() {
    let changed = false;
    for (const key of SETTINGS_KEYS) {
      if (state[key] === undefined) continue;
      const json = JSON.stringify(state[key]);
      if (snapshot["settings:" + key] === json) continue;
      lastPushAt["settings"] = Date.now();
      const { error } = await sb.from("settings").upsert({ key, value: state[key] });
      if (error) throw new Error("settings/" + key + " : " + error.message);
      snapshot["settings:" + key] = json;
      changed = true;
    }
    // Sélection "saisie rapide" : une clé settings PAR PROF (quickEntry:SMITH…)
    // pour que la sélection de chacun soit indépendante des 3 autres.
    if (state.quickEntry !== undefined) {
      const json = JSON.stringify(state.quickEntry);
      if (snapshot["settings:quickEntry"] !== json) {
        lastPushAt["settings"] = Date.now();
        const { error } = await sb.from("settings").upsert({ key: qeSettingsKey(), value: state.quickEntry });
        if (error) throw new Error("settings/quickEntry : " + error.message);
        snapshot["settings:quickEntry"] = json;
        changed = true;
      }
    }
    return changed;
  }

  function rebuildSnapshot() {   // après un chargement complet depuis la base
    Object.keys(TABLES).forEach(key => { snapshot[key] = toMap(state[key], TABLES[key]); });
    snapshot.teacherPresence = toMap(presenceToRows(state.teacherPresence),
                                     { pk: ["item_id", "teacher"], toRow: r => r });
    SETTINGS_KEYS.forEach(k => { snapshot["settings:" + k] = JSON.stringify(state[k]); });
  }

  /* ==========================================================================
   * 7) saveState() ENVELOPPÉ — localStorage + poussée différée (800 ms)
   * ========================================================================*/
  let syncTimer = null, syncing = false, pendingAgain = false, ready = false;

  async function syncNow() {
    if (!ready) return;
    if (syncing) { pendingAgain = true; return; }
    syncing = true;
    setBadge("synchronisation…", "#e67e22");
    try {
      for (const key of PUSH_ORDER) await pushTableDiff(key);
      await pushPresenceDiff();
      await pushSettingsDiff();
      setBadge("synchronisé", "#27ae60");
    } catch (e) {
      console.error("[STI2D] Échec de synchro :", e);
      setBadge("hors-ligne (localStorage)", "#c0392b");
    }
    syncing = false;
    if (pendingAgain) { pendingAgain = false; syncNow(); }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 800);
  }

  const originalSaveState = window.saveState;
  window.saveState = function () {
    try { originalSaveState(); } catch (e) {}   // cache local conservé
    scheduleSync();                             // + envoi vers Supabase
  };

  /* ==========================================================================
   * 8) TEMPS RÉEL — modifications des autres profs appliquées en direct
   *    Stratégie simple et sûre : à chaque événement sur une table, on la
   *    recharge intégralement (volumes faibles), sauf si c'est l'écho de
   *    notre propre écriture (< 3 s).
   * ========================================================================*/
  const TABLE_TO_KEY = {};
  Object.keys(TABLES).forEach(k => { TABLE_TO_KEY[TABLES[k].table] = k; });

  const refreshTimers = {};
  function onRemoteChange(payload) {
    const table = payload.table;
    if (Date.now() - (lastPushAt[table] || 0) < 3000) return;   // notre propre écho
    clearTimeout(refreshTimers[table]);
    refreshTimers[table] = setTimeout(() => refreshTable(table), 300);
  }

  async function refreshTable(table) {
    try {
      if (table === "teacher_presence") {
        state.teacherPresence = rowsToPresence(await fetchAll(table, r => r));
        snapshot.teacherPresence = toMap(presenceToRows(state.teacherPresence),
                                         { pk: ["item_id", "teacher"], toRow: r => r });
      } else if (table === "settings") {
        const { data } = await sb.from("settings").select("*");
        (data || []).forEach(r => {
          if (SETTINGS_KEYS.includes(r.key)) {
            state[r.key] = r.value;
            snapshot["settings:" + r.key] = JSON.stringify(r.value);
          } else if (r.key === qeSettingsKey()) {
            // Sélection "saisie rapide" du même prof, modifiée sur un autre appareil
            state.quickEntry = r.value;
            snapshot["settings:quickEntry"] = JSON.stringify(r.value);
          }
        });
      } else {
        const key = TABLE_TO_KEY[table];
        if (!key) return;
        state[key] = await fetchAll(table, TABLES[key].fromRow);
        snapshot[key] = toMap(state[key], TABLES[key]);
      }
      try { originalSaveState(); } catch (e) {}
      // Si la liste des élèves a changé chez un autre prof, les filtres
      // Groupe/Élève doivent être reconstruits avant le re-rendu.
      if (typeof window.populateFilters === "function") window.populateFilters();
      if (typeof window.renderAll === "function") window.renderAll();
      setBadge("mis à jour (autre prof)", "#2980b9");
      setTimeout(() => setBadge("synchronisé", "#27ae60"), 2500);
    } catch (e) { console.error("[STI2D] refresh " + table, e); }
  }

  function subscribeRealtime() {
    sb.channel("sti2d-sync")
      .on("postgres_changes", { event: "*", schema: "public" }, onRemoteChange)
      .subscribe();
  }

  /* ==========================================================================
   * 9) MIGRATION localStorage -> Supabase
   *    Pousse TOUT l'état courant (déjà chargé depuis localStorage par
   *    l'application) dans la base. Utilisable aussi en console : STI2D.migrate()
   * ========================================================================*/
  async function migrate() {
    setBadge("migration en cours…", "#8e44ad");
    Object.keys(snapshot).forEach(k => delete snapshot[k]);   // tout considérer nouveau
    for (const key of PUSH_ORDER) await pushTableDiff(key);
    await pushPresenceDiff();
    await pushSettingsDiff();
    ready = true;
    setBadge("migration terminée", "#27ae60");
    console.log("[STI2D] Migration terminée :",
      (state.progressions || []).length, "progressions,",
      (state.students || []).length, "élèves envoyés.");
  }

  /* ==========================================================================
   * 10) INDICATEUR VISUEL (petit badge en bas à droite)
   * ========================================================================*/
  let badge;
  function setBadge(text, color) {
    if (!badge) {
      badge = document.createElement("div");
      badge.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:9999;" +
        "padding:4px 10px;border-radius:12px;font:12px sans-serif;color:#fff;" +
        "opacity:.9;pointer-events:none;transition:background .3s";
      document.body.appendChild(badge);
    }
    badge.textContent = "☁ " + text;
    badge.style.background = color;
  }

  /* ==========================================================================
   * 12) SAISIE RAPIDE (onglet #quickEntryView) — mode tactile pour la classe
   *     - state.quickEntry = { student: "NOM Prénom" | null, sequence: id | null }
   *       persisté dans localStorage (via saveState) ET dans Supabase
   *       (table settings, clé "quickEntry:<PROF>", donc propre à chaque prof).
   *     - Chaque appui sur un bouton couleur écrit IMMÉDIATEMENT :
   *         séquence sélectionnée -> state.progressions (table progressions)
   *         pas de séquence       -> state.manual (table manual_evaluations)
   *       puis saveState() => localStorage + push différentiel Supabase.
   * ========================================================================*/
  const QE_STATUSES = [
    { key: "N", label: "Non évalué" },
    { key: "R", label: "Rouge" },
    { key: "O", label: "Orange" },
    { key: "Y", label: "Jaune" },
    { key: "G", label: "Vert" },
  ];

  function qeSettingsKey() { return "quickEntry:" + (currentTeacher || "anon"); }

  function qeEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function qeFindDetail(id) {
    return (state.sequences || []).find(x => x.id === id) ||
           (state.itProjects || []).find(x => x.id === id) || null;
  }

  // Garantit un state.quickEntry valide (références disparues -> null)
  function ensureQuickEntryState() {
    if (!state.quickEntry || typeof state.quickEntry !== "object")
      state.quickEntry = { student: null, sequence: null };
    if (state.quickEntry.student &&
        !(state.students || []).some(s => s.name === state.quickEntry.student))
      state.quickEntry.student = null;
    if (state.quickEntry.sequence && !qeFindDetail(state.quickEntry.sequence))
      state.quickEntry.sequence = null;
  }

  // ------- Sélection élève / séquence (appelées par le bottom sheet) -------
  window.selectStudentForQuickEntry = function (name) {
    ensureQuickEntryState();
    state.quickEntry.student = name || null;
    // Si la séquence en cours n'est pas du niveau du nouvel élève, on la vide
    const stu = (state.students || []).find(s => s.name === name);
    if (stu && stu.level && state.quickEntry.sequence) {
      const gi = (state.ganttItems || []).find(x => x.id === state.quickEntry.sequence);
      if (gi && !gi.row.startsWith(stu.level)) state.quickEntry.sequence = null;
    }
    window.saveState();               // localStorage + Supabase (différé 800 ms)
    closeQuickPicker();
    window.renderQuickEntry();
  };

  window.selectSequenceForQuickEntry = function (id) {
    ensureQuickEntryState();
    state.quickEntry.sequence = id || null;
    window.saveState();
    closeQuickPicker();
    window.renderQuickEntry();
  };

  // ------- Écriture d'un statut (auto-save immédiat, pas de bouton Valider) -------
  window.updateCompetencyStatus = function (code, status) {
    ensureQuickEntryState();
    const q = state.quickEntry;
    if (!q.student || !code || !QE_STATUSES.some(s => s.key === status)) return;
    if (q.sequence) {
      // Logique existante : séquence sélectionnée -> progression par séquence
      const ex = (state.progressions || []).find(p =>
        p.student === q.student && p.competencyCode === code && p.itemId === q.sequence);
      if (ex) ex.status = status;
      else state.progressions.push({ student: q.student, competencyCode: code, itemId: q.sequence, status });
    } else {
      // Pas de séquence -> évaluation manuelle globale
      const scoreMap = { N: 0, R: 1, O: 2, Y: 3, G: 4 };
      const row = { student: q.student, competencyCode: code, status, score: scoreMap[status] || 0 };
      const i = (state.manual || []).findIndex(m => m.student === q.student && m.competencyCode === code);
      if (i >= 0) state.manual[i] = row; else state.manual.push(row);
    }
    window.saveState();               // localStorage + push Supabase automatique

    // Retour visuel immédiat sur la carte concernée (préserve la position de scroll)
    const card = document.querySelector('#quickEntryList .qeCompCard[data-code="' + code + '"]');
    if (card) card.querySelectorAll(".qeStatusBtn").forEach(b =>
      b.classList.toggle("qeActive", b.dataset.status === status));

    // Les autres vues restent cohérentes
    try { if (typeof window.renderStudent === "function") window.renderStudent(); } catch (e) {}
    try { if (typeof window.renderClass === "function") window.renderClass(); } catch (e) {}
  };

  // ------- Rendu de l'onglet -------
  window.renderQuickEntry = function () {
    const list = document.getElementById("quickEntryList");
    if (!list) return;                 // section absente : ne rien faire
    ensureQuickEntryState();
    const q = state.quickEntry;
    const detail = q.sequence ? qeFindDetail(q.sequence) : null;

    const stuEl = document.getElementById("qeCurrentStudent");
    const seqEl = document.getElementById("qeCurrentSequence");
    if (stuEl) { stuEl.textContent = q.student || "Aucun élève"; stuEl.classList.toggle("empty", !q.student); }
    if (seqEl) { seqEl.textContent = detail ? detail.title : "Aucune séquence"; seqEl.classList.toggle("empty", !detail); }

    if (!q.student || !detail) {
      list.innerHTML = '<div class="qeHint">Choisis un <strong>élève</strong> et une <strong>séquence</strong> ' +
        "avec les boutons ci-dessus.<br>Chaque appui sur une couleur est enregistré immédiatement.</div>";
      return;
    }
    const codes = (detail.competencies || []).slice().sort((a, b) => a.localeCompare(b, "fr"));
    if (!codes.length) {
      list.innerHTML = '<div class="qeHint">Aucune compétence associée à cette séquence.</div>';
      return;
    }
    list.innerHTML = codes.map(code => {
      const prog = (state.progressions || []).find(p =>
        p.student === q.student && p.competencyCode === code && p.itemId === q.sequence);
      const cur = prog ? prog.status : "N";
      const label = (typeof window.competencyLabel === "function") ? window.competencyLabel(code) : code;
      return '<div class="qeCompCard" data-code="' + qeEsc(code) + '">' +
        '<p class="qeCompName">' + qeEsc(code) + "</p>" +
        '<p class="qeCompLabel">' + qeEsc(label) + "</p>" +
        '<div class="qeStatusRow">' +
        QE_STATUSES.map(s =>
          '<button type="button" class="qeStatusBtn qe' + s.key + (cur === s.key ? " qeActive" : "") +
          '" data-status="' + s.key + '" aria-label="' + s.label + '" title="' + s.label + '">' +
          s.key + "</button>").join("") +
        "</div></div>";
    }).join("");
    list.querySelectorAll(".qeCompCard").forEach(card => {
      card.querySelectorAll(".qeStatusBtn").forEach(btn =>
        btn.addEventListener("click", () =>
          window.updateCompetencyStatus(card.dataset.code, btn.dataset.status)));
    });
  };

  // ------- Bottom sheet : liste des élèves ou des séquences -------
  function openQuickPicker(type) {
    ensureQuickEntryState();
    const ov = document.getElementById("qeOverlay");
    const body = document.getElementById("qeSheetBody");
    const title = document.getElementById("qeSheetTitle");
    if (!ov || !body || !title) return;
    const q = state.quickEntry;

    if (type === "student") {
      title.textContent = "Choisir un élève";
      const stus = (state.students || []).slice().sort((a, b) =>
        (a.group || "").localeCompare(b.group || "", "fr") || a.name.localeCompare(b.name, "fr"));
      let html = "", lastGroup = null;
      stus.forEach(s => {
        if (s.group !== lastGroup) {
          lastGroup = s.group;
          html += '<div class="qeSheetGroup">' + qeEsc(s.group || s.level || "Sans groupe") + "</div>";
        }
        html += '<button type="button" class="qeSheetItem' + (q.student === s.name ? " qeSelected" : "") +
          '" data-pick-student="' + qeEsc(s.name) + '"><span>' + qeEsc(s.name) +
          "</span><small>" + qeEsc(s.level || "") + "</small></button>";
      });
      body.innerHTML = html || '<div class="qeHint">Aucun élève.</div>';
      body.querySelectorAll("[data-pick-student]").forEach(b =>
        b.addEventListener("click", () => window.selectStudentForQuickEntry(b.dataset.pickStudent)));
    } else {
      title.textContent = "Choisir une séquence";
      const stu = (state.students || []).find(s => s.name === q.student);
      let items = (state.ganttItems || []).slice().sort((a, b) => a.startWeek - b.startWeek);
      if (stu && stu.level) items = items.filter(x => x.row.startsWith(stu.level)); // niveau de l'élève
      let html = "", lastRow = null;
      items.forEach(gi => {
        const d = qeFindDetail(gi.id);
        if (!d) return;
        if (gi.row !== lastRow) { lastRow = gi.row; html += '<div class="qeSheetGroup">' + qeEsc(gi.row) + "</div>"; }
        const n = (d.competencies || []).length;
        html += '<button type="button" class="qeSheetItem' + (q.sequence === gi.id ? " qeSelected" : "") +
          '" data-pick-sequence="' + qeEsc(gi.id) + '"><span>' + qeEsc(d.title) +
          "</span><small>" + qeEsc(gi.id) + " · " + n + " comp.</small></button>";
      });
      body.innerHTML = html || '<div class="qeHint">' +
        (stu && stu.level ? "Aucune séquence pour le niveau " + qeEsc(stu.level) + "." : "Aucune séquence.") + "</div>";
      body.querySelectorAll("[data-pick-sequence]").forEach(b =>
        b.addEventListener("click", () => window.selectSequenceForQuickEntry(b.dataset.pickSequence)));
    }
    ov.classList.add("visible");
    body.scrollTop = 0;
  }

  function closeQuickPicker() {
    const ov = document.getElementById("qeOverlay");
    if (ov) ov.classList.remove("visible");
  }

  // ------- Branchement des événements + intégration au renderAll() global -------
  (function initQuickEntry() {
    const pickStu = document.getElementById("qePickStudentBtn");
    const pickSeq = document.getElementById("qePickSequenceBtn");
    const closeBtn = document.getElementById("qeSheetClose");
    const ov = document.getElementById("qeOverlay");
    if (pickStu) pickStu.addEventListener("click", () => openQuickPicker("student"));
    if (pickSeq) pickSeq.addEventListener("click", () => openQuickPicker("sequence"));
    if (closeBtn) closeBtn.addEventListener("click", closeQuickPicker);
    if (ov) ov.addEventListener("click", e => { if (e.target === ov) closeQuickPicker(); });
    // renderAll() (défini dans index.html) rafraîchit désormais aussi cet onglet,
    // y compris lors des mises à jour temps réel venant des autres profs.
    const originalRenderAll = window.renderAll;
    if (typeof originalRenderAll === "function") {
      window.renderAll = function () {
        originalRenderAll();
        try { window.renderQuickEntry(); } catch (e) { console.error("[STI2D] renderQuickEntry :", e); }
      };
    }
    try { window.renderQuickEntry(); } catch (e) {}
  })();

  /* ==========================================================================
   * 11) DÉMARRAGE
   * ========================================================================*/
  async function boot() {
    setBadge("connexion…", "#7f8c8d");
    const session = await ensureAuth();
    showLogoutButton(session);
    setBadge("chargement…", "#7f8c8d");

    const { count, error } = await sb.from("students").select("*", { count: "exact", head: true });
    if (error) { setBadge("erreur : schéma manquant ?", "#c0392b"); throw error; }

    if (!count) {
      // Base vide -> proposer la migration des données locales actuelles
      if (window.confirm("La base Supabase est vide.\n\nMigrer les données actuelles " +
          "(localStorage) vers Supabase maintenant ?\n\nÉlèves : " +
          (state.students || []).length + " — Progressions : " +
          (state.progressions || []).length)) {
        await migrate();
      } else {
        setBadge("base vide — migration non faite", "#c0392b");
        return;
      }
    } else {
      // Base remplie -> elle fait foi : on remplace l'état local et on re-rend
      const remote = await fetchRemoteState();
      Object.keys(remote).forEach(k => { state[k] = remote[k]; });
      if (!state.selectedGanttRow) state.selectedGanttRow = "all";
      if (!state.selectedSequenceId)
        state.selectedSequenceId = (state.ganttItems || [])[0]?.id || null;
      rebuildSnapshot();
      // Restaurer la sélection "saisie rapide" du prof connecté (multi-appareils)
      try {
        const { data: qe } = await sb.from("settings").select("value").eq("key", qeSettingsKey()).maybeSingle();
        if (qe && qe.value) state.quickEntry = qe.value;
        snapshot["settings:quickEntry"] = JSON.stringify(state.quickEntry);
      } catch (e) { /* clé absente : première utilisation */ }
      try { originalSaveState(); } catch (e) {}   // rafraîchit le cache local
      if (typeof window.populateFilters === "function") window.populateFilters();
      if (typeof window.renderAll === "function") window.renderAll();
      ready = true;
      setBadge("synchronisé", "#27ae60");
    }
    subscribeRealtime();
  }

  // API console pour Damien
  window.STI2D = {
    supabase: sb, migrate, syncNow, fetchRemoteState,
    teacher: () => currentTeacher,
    logout: () => sb.auth.signOut().then(() => location.reload()),
  };

  boot().catch(e => console.error("[STI2D] Démarrage Supabase :", e));
})();
