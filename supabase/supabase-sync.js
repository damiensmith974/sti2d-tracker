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
