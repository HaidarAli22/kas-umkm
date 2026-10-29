import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
  Timestamp,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCIyjHyaaQ1E5NnzKtVhTGXxM5fIhbKTGw",
  authDomain: "kas-umkm-fd883.firebaseapp.com",
  projectId: "kas-umkm-fd883",
  storageBucket: "kas-umkm-fd883.firebasestorage.app",
  messagingSenderId: "351453490532",
  appId: "1:351453490532:web:9e8a3e176adf1e0cb7de71",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const $ = (id) => document.getElementById(id);

let semua = [];
let dataSiap = false;
let toastTimer;
let transaksiRef = null; // diisi sesuai akun yang masuk
let unsub = null; // penghenti listener Firestore

const rupiah = (n) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);

const isoHariIni = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const tanggalTeks = (t) => {
  const d = t.tanggal?.toDate
    ? t.tanggal.toDate()
    : t.tanggal
      ? new Date(t.tanggal)
      : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
};

// Nilai waktu (ms) untuk pengurutan, dari Timestamp Firestore maupun tanggal biasa.
const ms = (ts) => {
  if (!ts) return 0;
  if (ts.toMillis) return ts.toMillis();
  if (ts.toDate) return ts.toDate().getTime();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};

// Daftar kategori + efeknya. Angka = arah × nominal:
//   kas  +naik/−turun saldo kas (0 = catatan, tidak menyentuh kas)
//   utang / piutang   +menambah / −mengurangi saldo terkait
//   pendapatan / beban / modal   untuk ringkasan laba-rugi & modal
const KATEGORI = {
  Penjualan: { jenis: "debit", kas: 1, pendapatan: 1 },
  Modal: { jenis: "debit", kas: 1, modal: 1 },
  Piutang: { jenis: "debit", kas: 0, piutang: 1 },
  "Terima Piutang": { jenis: "debit", kas: 1, piutang: -1, pendapatan: 1 },
  Kulakan: { jenis: "kredit", kas: -1, beban: 1 },
  Utang: { jenis: "kredit", kas: 0, utang: 1 },
  "Bayar Utang": { jenis: "kredit", kas: -1, utang: -1, beban: 1 },
};

function isiKategori() {
  const jenis = $("jenis").value;
  const opsi = Object.keys(KATEGORI).filter(
    (nama) => KATEGORI[nama].jenis === jenis,
  );
  $("kategori").replaceChildren(
    ...opsi.map((nama) => {
      const o = document.createElement("option");
      o.value = nama;
      o.textContent = nama;
      return o;
    }),
  );
}

// Nilai transaksi terhadap kas (data lama tanpa kategori memakai jenis-nya).
function nilaiKas(t) {
  const info = KATEGORI[t.kategori];
  const j = Number(t.jumlah) || 0;
  if (info) return (info.kas || 0) * j;
  if (t.jenis === "debit") return j;
  if (t.jenis === "kredit") return -j;
  return 0;
}

// Total suatu properti (pendapatan, beban, modal, utang, piutang) dari semua transaksi.
const totalProperti = (prop) =>
  semua.reduce((s, t) => {
    const info = KATEGORI[t.kategori];
    return info && info[prop] ? s + info[prop] * (Number(t.jumlah) || 0) : s;
  }, 0);

async function tambahTransaksi(data) {
  if (!transaksiRef) throw new Error("Sesi berakhir, silakan masuk lagi.");

  const jumlah = Number(data.jumlah);
  if (!Number.isSafeInteger(jumlah) || jumlah <= 0)
    throw new Error("Nominal harus berupa bilangan bulat positif.");

  const info = KATEGORI[data.kategori];
  if (!info || info.jenis !== data.jenis)
    throw new Error("Kategori tidak sesuai dengan jenis transaksi.");
  if (!data.tanggal) throw new Error("Tanggal harus diisi.");

  const tanggal = new Date(`${data.tanggal}T00:00:00`);
  if (Number.isNaN(tanggal.getTime())) throw new Error("Tanggal tidak valid.");

  await addDoc(transaksiRef, {
    jenis: data.jenis,
    kategori: data.kategori,
    tanggal: Timestamp.fromDate(tanggal),
    jumlah,
    keterangan: String(data.keterangan || "").trim(),
    dibuatPada: serverTimestamp(),
  });
}

function toast(pesan) {
  const el = $("toast");
  el.textContent = pesan;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

function bukaView(nama) {
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.toggle("active", v.id === `view-${nama}`));
  document
    .querySelectorAll(".nav-item")
    .forEach((i) => i.classList.toggle("active", i.dataset.view === nama));
  $("sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Tampilan jenis, nominal, dan ikon diturunkan dari pengaruh kas-nya.
const jenisTeks = (t) => {
  const k = nilaiKas(t);
  return k > 0 ? "Debit" : k < 0 ? "Kredit" : "Catatan";
};

function nominalTeks(t) {
  const k = nilaiKas(t);
  if (k > 0) return { teks: `+ ${rupiah(t.jumlah)}`, kelas: "amount-in" };
  if (k < 0) return { teks: `− ${rupiah(t.jumlah)}`, kelas: "amount-out" };
  return { teks: rupiah(t.jumlah), kelas: "" };
}

const kelasNum = (k) => (k ? k + " " : "") + "col-num";

function sel(teks, kelas = "") {
  const td = document.createElement("td");
  td.textContent = teks;
  if (kelas) td.className = kelas;
  return td;
}

function kosong(tbody, kolom, pesan = "Belum ada transaksi") {
  const td = sel(pesan, "empty-cell");
  td.colSpan = kolom;
  const tr = document.createElement("tr");
  tr.appendChild(td);
  tbody.replaceChildren(tr);
}

// Sel pertama tabel: ikon + kategori + keterangan.
function selNama(t) {
  const k = nilaiKas(t);
  const ikon = k > 0 ? "↗" : k < 0 ? "↘" : "•";
  const td = document.createElement("td");
  td.innerHTML = `<div class="transaction-name">
      <span class="transaction-symbol">${ikon}</span>
      <div><strong></strong><small></small></div>
    </div>`;
  td.querySelector("strong").textContent = t.kategori || "Transaksi";
  td.querySelector("small").textContent = t.keterangan || "—";
  return td;
}

function renderTerbaru() {
  const tbody = $("transaksi-terbaru");
  const list = semua.slice(0, 5);
  if (!list.length) return kosong(tbody, 4);
  tbody.replaceChildren(
    ...list.map((t) => {
      const tr = document.createElement("tr");
      const n = nominalTeks(t);
      tr.append(
        selNama(t),
        sel(tanggalTeks(t)),
        sel(jenisTeks(t)),
        sel(n.teks, kelasNum(n.kelas)),
      );
      return tr;
    }),
  );
}

function renderRiwayat() {
  const tbody = $("daftar-riwayat");
  const kata = $("cari").value.trim().toLocaleLowerCase("id-ID");
  const list = semua
    .filter((t) =>
      [t.kategori, t.keterangan, jenisTeks(t)]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("id-ID")
        .includes(kata),
    )
    .sort(
      (a, b) =>
        ms(a.tanggal) - ms(b.tanggal) || ms(a.dibuatPada) - ms(b.dibuatPada),
    );

  $("jumlah-riwayat").textContent = `${list.length} transaksi`;
  if (!list.length)
    return kosong(
      tbody,
      5,
      kata ? "Tidak ada transaksi yang cocok" : "Belum ada transaksi",
    );

  tbody.replaceChildren(
    ...list.map((t) => {
      const tr = document.createElement("tr");
      const n = nominalTeks(t);
      tr.append(
        selNama(t),
        sel(tanggalTeks(t)),
        sel(jenisTeks(t)),
        sel(n.teks, kelasNum(n.kelas)),
      );

      const tdAksi = document.createElement("td");
      const hapus = document.createElement("button");
      hapus.className = "delete-button";
      hapus.type = "button";
      hapus.textContent = "×";
      hapus.setAttribute("aria-label", "Hapus transaksi");
      hapus.addEventListener("click", async () => {
        if (!confirm(`Hapus "${t.kategori}" sebesar ${rupiah(t.jumlah)}?`))
          return;
        hapus.disabled = true;
        try {
          await deleteDoc(doc(transaksiRef, t.id));
          toast("Transaksi dihapus.");
        } catch (err) {
          toast(`Gagal menghapus: ${err.message}`);
          hapus.disabled = false;
        }
      });
      tdAksi.appendChild(hapus);
      tr.appendChild(tdAksi);
      return tr;
    }),
  );
}

// Menu Utang / Piutang: semua transaksi yang memengaruhi saldonya + total bersih.
function renderCatatan(kunci) {
  const list = semua.filter((t) => KATEGORI[t.kategori]?.[kunci]);
  $(`total-${kunci}`).textContent = rupiah(totalProperti(kunci));

  const tbody = $(`daftar-${kunci}`);
  if (!list.length) return kosong(tbody, 3, `Belum ada ${kunci}`);
  tbody.replaceChildren(
    ...list.map((t) => {
      const tr = document.createElement("tr");
      const arah = KATEGORI[t.kategori][kunci]; // +1 menambah, −1 mengurangi
      const teks = (arah < 0 ? "− " : "") + rupiah(t.jumlah);
      tr.append(
        sel(t.keterangan || t.kategori),
        sel(tanggalTeks(t)),
        sel(teks, kelasNum(arah < 0 ? "amount-out" : "")),
      );
      return tr;
    }),
  );
}

function renderDashboard() {
  $("saldo").textContent = rupiah(semua.reduce((s, t) => s + nilaiKas(t), 0));
  $("modal").textContent = rupiah(totalProperti("modal"));

  const labaRugi = totalProperti("pendapatan") - totalProperti("beban");
  $("laba").textContent = rupiah(Math.max(labaRugi, 0));
  $("rugi").textContent = rupiah(Math.max(-labaRugi, 0));

  const masuk = semua.reduce((s, t) => s + Math.max(0, nilaiKas(t)), 0);
  const keluar = semua.reduce((s, t) => s + Math.max(0, -nilaiKas(t)), 0);
  const total = masuk + keluar;
  const persen = total ? Math.round((masuk / total) * 100) : 0;
  $("pie").style.background = total
    ? `conic-gradient(var(--green) 0% ${persen}%, var(--line) ${persen}% 100%)`
    : "conic-gradient(var(--line) 0% 100%)";
  $("total-arus").textContent = rupiah(total);
  $("total-masuk").textContent = rupiah(masuk);
  $("total-keluar").textContent = rupiah(keluar);
}

function renderSemua() {
  renderDashboard();
  renderTerbaru();
  renderRiwayat();
  renderCatatan("utang");
  renderCatatan("piutang");
}

// ---------------- Autentikasi ----------------
let modeAuth = "login";

function pesanAuth(teks, error = true) {
  const el = $("auth-pesan");
  el.textContent = teks;
  el.classList.toggle("error", error && !!teks);
}

function setMode(mode) {
  modeAuth = mode;
  const daftar = mode === "register";
  $("tab-login").classList.toggle("active", !daftar);
  $("tab-register").classList.toggle("active", daftar);
  $("auth-konfirmasi-wrap").classList.toggle("is-hidden", !daftar);
  $("auth-konfirmasi").required = daftar;
  $("auth-submit").textContent = daftar ? "Daftar" : "Masuk";
  $("auth-password").setAttribute(
    "autocomplete",
    daftar ? "new-password" : "current-password",
  );
  $("form-auth").reset(); // kosongkan isian agar tidak terbawa antar-tab
  pesanAuth("");

  // Animasi singkat tiap berpindah tab.
  const f = $("form-auth");
  f.classList.remove("switch-anim");
  void f.offsetWidth;
  f.classList.add("switch-anim");
}

const pesanError = (code) =>
  ({
    "auth/invalid-email": "Format email tidak valid.",
    "auth/email-already-in-use": "Email sudah terdaftar. Silakan masuk.",
    "auth/weak-password": "Kata sandi minimal 6 karakter.",
    "auth/missing-password": "Kata sandi harus diisi.",
    "auth/wrong-password": "Email atau kata sandi salah.",
    "auth/user-not-found": "Email atau kata sandi salah.",
    "auth/invalid-credential": "Email atau kata sandi salah.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi nanti.",
    "auth/network-request-failed": "Gagal terhubung. Periksa koneksi internet.",
    "auth/operation-not-allowed":
      "Aktifkan metode Email/Password di Firebase Console → Authentication.",
    "auth/configuration-not-found":
      "Firebase Authentication belum diaktifkan. Buka Console → Authentication → Get started.",
    "auth/admin-restricted-operation":
      "Pendaftaran dibatasi. Aktifkan Email/Password di Firebase Console.",
  })[code] || `Terjadi kesalahan${code ? ` (${code})` : ""}. Coba lagi.`;

$("tab-login").addEventListener("click", () => setMode("login"));
$("tab-register").addEventListener("click", () => setMode("register"));

$("form-auth").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const sandi = $("auth-password").value;
  if (modeAuth === "register" && sandi !== $("auth-konfirmasi").value)
    return pesanAuth("Konfirmasi kata sandi tidak sama.");

  const tombol = $("auth-submit");
  const label = tombol.textContent;
  tombol.disabled = true;
  tombol.textContent = "Memproses...";
  try {
    if (modeAuth === "register") {
      await createUserWithEmailAndPassword(auth, email, sandi);
    } else {
      await signInWithEmailAndPassword(auth, email, sandi);
    }
    $("form-auth").reset();
    pesanAuth("");
  } catch (err) {
    console.error(err);
    pesanAuth(pesanError(err.code));
  } finally {
    tombol.disabled = false;
    tombol.textContent = label;
  }
});

$("btn-logout").addEventListener("click", () => signOut(auth));

// ---------------- Listener data per akun ----------------
function mulaiListener(uid) {
  transaksiRef = collection(db, "tokos", uid, "transaksi");
  unsub = onSnapshot(
    query(transaksiRef, orderBy("tanggal", "desc")),
    (snap) => {
      semua = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      dataSiap = true;
      renderSemua();
    },
    (err) => {
      console.error("Firebase Firestore error:", err);
      dataSiap = false;
      toast("Tidak dapat memuat data dari Firebase.");
    },
  );
}

function berhentiListener() {
  if (unsub) {
    unsub();
    unsub = null;
  }
  transaksiRef = null;
  dataSiap = false;
}

function tampilAplikasi(u) {
  berhentiListener();
  semua = [];
  $("auth").classList.add("is-hidden");
  $("app-shell").classList.remove("is-hidden");
  $("user-email").textContent = u.email || "";
  bukaView("beranda");
  renderSemua();
  mulaiListener(u.uid);
}

function tampilAuth() {
  berhentiListener();
  semua = [];
  $("app-shell").classList.add("is-hidden");
  $("auth").classList.remove("is-hidden");
  setMode("login");
}

onAuthStateChanged(auth, (u) => (u ? tampilAplikasi(u) : tampilAuth()));

// ---------------- Event umum & inisialisasi ----------------
document
  .querySelectorAll("[data-view]")
  .forEach((el) =>
    el.addEventListener("click", () => bukaView(el.dataset.view)),
  );
$("btn-menu").addEventListener("click", () =>
  document.querySelector(".sidebar").classList.toggle("open"),
);
$("brand-home").addEventListener("click", (e) => {
  e.preventDefault();
  bukaView("beranda");
});

const form = $("form-transaksi");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!dataSiap) return toast("Data belum selesai dimuat. Coba lagi sebentar.");

  const data = Object.fromEntries(new FormData(form));
  const tombol = form.querySelector(".primary-button");
  tombol.disabled = true;
  tombol.textContent = "Menyimpan...";
  try {
    await tambahTransaksi(data);
    form.reset();
    isiKategori();
    $("tanggal").value = isoHariIni();
    toast("Transaksi berhasil disimpan.");
    bukaView("beranda");
  } catch (err) {
    console.error(err);
    toast(err.message || "Transaksi gagal disimpan.");
  } finally {
    tombol.disabled = false;
    tombol.textContent = "Simpan";
  }
});

$("cari").addEventListener("input", renderRiwayat);
$("jenis").addEventListener("change", isiKategori);
isiKategori();
$("tanggal").value = isoHariIni();
$("tanggal-hari").textContent = new Date().toLocaleDateString("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function tutupSplash() {
  const splash = $("splash");
  if (!splash || splash.classList.contains("leaving")) return;
  splash.classList.add("leaving");
  setTimeout(() => splash.remove(), 700);
}
setTimeout(tutupSplash, 1900);
