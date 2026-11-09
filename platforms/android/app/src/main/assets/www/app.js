// app.js: logika Kas UMKM (login, simpan data, hitung, tampilkan)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  updateDoc,
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

// Konfigurasi proyek Firebase
const firebaseConfig = {
  apiKey: "AIzaSyCIyjHyaaQ1E5NnzKtVhTGXxM5fIhbKTGw",
  authDomain: "kas-umkm-fd883.firebaseapp.com",
  projectId: "kas-umkm-fd883",
  storageBucket: "kas-umkm-fd883.firebasestorage.app",
  messagingSenderId: "351453490532",
  appId: "1:351453490532:web:9e8a3e176adf1e0cb7de71",
};

// Sambung ke Firebase; $ = ambil elemen by id
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const $ = (id) => document.getElementById(id);

// State: data transaksi & penanda
let semua = [];
let dataSiap = false;
let toastTimer;
let transaksiRef = null; // diisi sesuai akun yang masuk
let unsub = null; // penghenti listener Firestore
let editId = null; // id transaksi yang sedang diedit (null = transaksi baru)

// Format angka ke Rupiah
const rupiah = (n) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);

// Date -> teks YYYY-MM-DD (zona waktu lokal)
const isoDari = (d) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
};
const isoHariIni = () => isoDari(new Date());

// Ambil tanggal transaksi sebagai Date (null jika kosong/tidak valid)
const tanggalObj = (t) => {
  const d = t.tanggal?.toDate
    ? t.tanggal.toDate()
    : t.tanggal
      ? new Date(t.tanggal)
      : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const ymd = (t) => (tanggalObj(t) ? isoDari(tanggalObj(t)) : "");

// Ikon dari Lucide (lucide.dev); gambarnya didefinisikan di index.html (<symbol id="i-...">)
const svgIkon = (nama) => `<svg class="ikon"><use href="#i-${nama}" /></svg>`;

// Format tanggal ke teks Indonesia
const tanggalTeks = (t) =>
  tanggalObj(t)?.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }) ?? "—";

// Urutan terbaru dulu: tanggal transaksi, lalu waktu dicatat (agar transaksi di hari yang sama tidak acak)
const waktu = (ts) =>
  ts?.toMillis ? ts.toMillis() : ts ? new Date(ts).getTime() || 0 : 0;
const urutTerbaru = (a, b) =>
  waktu(b.tanggal) - waktu(a.tanggal) ||
  waktu(b.dibuatPada) - waktu(a.dibuatPada);

// Aturan tiap kategori: dampak ke kas, utang, piutang, laba-rugi, modal
const KATEGORI = {
  Penjualan: { jenis: "debit", kas: 1, pendapatan: 1 },
  Modal: { jenis: "debit", kas: 1, modal: 1 },
  Piutang: { jenis: "debit", kas: 0, piutang: 1 },
  "Terima Piutang": { jenis: "debit", kas: 1, piutang: -1, pendapatan: 1 },
  Kulakan: { jenis: "kredit", kas: -1, beban: 1 },
  "Biaya Operasional": { jenis: "kredit", kas: -1, beban: 1 },
  Utang: { jenis: "kredit", kas: 0, utang: 1 },
  "Bayar Utang": { jenis: "kredit", kas: -1, utang: -1, beban: 1 },
};

// Isi dropdown kategori sesuai jenis
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

// Dampak transaksi ke kas (+/−/0)
function nilaiKas(t) {
  const info = KATEGORI[t.kategori];
  const j = Number(t.jumlah) || 0;
  if (info) return (info.kas || 0) * j;
  if (t.jenis === "debit") return j;
  if (t.jenis === "kredit") return -j;
  return 0;
}

// Jumlahkan satu properti (pendapatan, beban, dll)
const totalProperti = (prop) =>
  semua.reduce((s, t) => {
    const info = KATEGORI[t.kategori];
    return info && info[prop] ? s + info[prop] * (Number(t.jumlah) || 0) : s;
  }, 0);

// Periksa input; hasilnya data siap simpan
function validasi(data) {
  const jumlah = Number(data.jumlah);
  if (!Number.isSafeInteger(jumlah) || jumlah <= 0)
    throw new Error("Nominal harus berupa bilangan bulat positif.");

  const info = KATEGORI[data.kategori];
  if (!info || info.jenis !== data.jenis)
    throw new Error("Kategori tidak sesuai dengan jenis transaksi.");
  if (!data.tanggal) throw new Error("Tanggal harus diisi.");

  const tanggal = new Date(`${data.tanggal}T00:00:00`);
  if (Number.isNaN(tanggal.getTime())) throw new Error("Tanggal tidak valid.");

  return {
    jenis: data.jenis,
    kategori: data.kategori,
    tanggal: Timestamp.fromDate(tanggal),
    jumlah,
    keterangan: String(data.keterangan || "").trim(),
  };
}

// Simpan ke Firestore: transaksi baru (addDoc) atau perubahan (updateDoc)
async function simpanTransaksi(data) {
  if (!transaksiRef) throw new Error("Sesi berakhir, silakan masuk lagi.");
  const isi = validasi(data);
  if (editId) await updateDoc(doc(transaksiRef, editId), isi);
  else await addDoc(transaksiRef, { ...isi, dibuatPada: serverTimestamp() });
}

// Notifikasi kecil 3 detik
function toast(pesan) {
  const el = $("toast");
  el.textContent = pesan;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

// Pindah halaman
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

// Label Debit / Kredit / Catatan
const jenisTeks = (t) => {
  const k = nilaiKas(t);
  return k > 0 ? "Debit" : k < 0 ? "Kredit" : "Catatan";
};

// Nominal bertanda +/− dan warna
function nominalTeks(t) {
  const k = nilaiKas(t);
  if (k > 0) return { teks: `+ ${rupiah(t.jumlah)}`, kelas: "amount-in" };
  if (k < 0) return { teks: `− ${rupiah(t.jumlah)}`, kelas: "amount-out" };
  return { teks: rupiah(t.jumlah), kelas: "" };
}

// Kelas kolom angka
const kelasNum = (k) => (k ? k + " " : "") + "col-num";

// Buat sel <td>
function sel(teks, kelas = "") {
  const td = document.createElement("td");
  td.textContent = teks;
  if (kelas) td.className = kelas;
  return td;
}

// Baris 'data kosong'
function kosong(tbody, kolom, pesan = "Belum ada transaksi") {
  const td = sel(pesan, "empty-cell");
  td.colSpan = kolom;
  const tr = document.createElement("tr");
  tr.appendChild(td);
  tbody.replaceChildren(tr);
}

// Sel nama: ikon + kategori + keterangan
function selNama(t) {
  const k = nilaiKas(t);
  const ikon = k > 0 ? "arrow-up-right" : k < 0 ? "arrow-down-right" : "minus";
  const td = document.createElement("td");
  td.innerHTML = `<div class="transaction-name">
      <span class="transaction-symbol">${svgIkon(ikon)}</span>
      <div><strong></strong><small></small></div>
    </div>`;
  td.querySelector("strong").textContent = t.kategori || "Transaksi";
  td.querySelector("small").textContent = t.keterangan || "—";
  return td;
}

// Tabel 5 transaksi terbaru
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

// Kosongkan semua filter riwayat (tanpa menggambar ulang)
function resetFilter() {
  ["cari", "filter-dari", "filter-sampai"].forEach((id) => ($(id).value = ""));
}

// Tabel riwayat: cari + filter tanggal, ringkasan masuk/keluar, edit, hapus
function renderRiwayat() {
  const tbody = $("daftar-riwayat");
  const kata = $("cari").value.trim().toLocaleLowerCase("id-ID");
  const dari = $("filter-dari").value;
  const sampai = $("filter-sampai").value;
  const list = semua.filter((t) => {
    const tgl = ymd(t);
    return (
      (!dari || (tgl && tgl >= dari)) &&
      (!sampai || (tgl && tgl <= sampai)) &&
      [t.kategori, t.keterangan, jenisTeks(t)]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("id-ID")
        .includes(kata)
    );
  });

  // Ringkasan dari transaksi yang sedang tampil
  const masuk = list.reduce((s, t) => s + Math.max(0, nilaiKas(t)), 0);
  const keluar = list.reduce((s, t) => s + Math.max(0, -nilaiKas(t)), 0);
  $("sum-masuk").textContent = rupiah(masuk);
  $("sum-keluar").textContent = rupiah(keluar);
  $("sum-bersih").textContent = rupiah(masuk - keluar);

  $("jumlah-riwayat").textContent = `${list.length} transaksi`;
  if (!list.length)
    return kosong(
      tbody,
      5,
      kata || dari || sampai
        ? "Tidak ada transaksi yang cocok"
        : "Belum ada transaksi",
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

      const edit = document.createElement("button");
      edit.className = "edit-button";
      edit.type = "button";
      edit.innerHTML = svgIkon("pencil");
      edit.setAttribute("aria-label", "Edit transaksi");
      edit.addEventListener("click", () => mulaiEdit(t));

      const hapus = document.createElement("button");
      hapus.className = "delete-button";
      hapus.type = "button";
      hapus.innerHTML = svgIkon("x");
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

      const aksi = document.createElement("div");
      aksi.className = "row-actions";
      aksi.append(edit, hapus);
      const tdAksi = document.createElement("td");
      tdAksi.appendChild(aksi);
      tr.appendChild(tdAksi);
      return tr;
    }),
  );
}

// Kartu saldo, modal, laba, rugi + arus kas (donat, utang, piutang)
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
  $("total-utang").textContent = rupiah(totalProperti("utang"));
  $("total-piutang").textContent = rupiah(totalProperti("piutang"));
}

// Gambar ulang semua tampilan
function renderSemua() {
  renderDashboard();
  renderTerbaru();
  renderRiwayat();
}

// Autentikasi: mode login/daftar
let modeAuth = "login";

// Pesan di form login
function pesanAuth(teks, error = true) {
  const el = $("auth-pesan");
  el.textContent = teks;
  el.classList.toggle("error", error && !!teks);
}

// Ganti tab Masuk/Daftar
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

  const f = $("form-auth");
  f.classList.remove("switch-anim");
  void f.offsetWidth;
  f.classList.add("switch-anim");
}

// Terjemah error Firebase
const pesanError = (code) =>
  ({
    "auth/invalid-email": "Format email tidak valid.",
    "auth/email-already-in-use": "Email sudah terdaftar. Silakan masuk.",
    "auth/weak-password": "Kata sandi minimal 6 karakter.",
    "auth/invalid-credential": "Email atau kata sandi salah.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi nanti.",
    "auth/network-request-failed": "Gagal terhubung. Periksa koneksi internet.",
  })[code] || `Terjadi kesalahan${code ? ` (${code})` : ""}. Coba lagi.`;

// Klik tab
$("tab-login").addEventListener("click", () => setMode("login"));
$("tab-register").addEventListener("click", () => setMode("register"));

// Submit: daftar atau masuk
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

// Keluar
$("btn-logout").addEventListener("click", () => signOut(auth));

// Dengar data realtime milik akun ini
function mulaiListener(uid) {
  transaksiRef = collection(db, "tokos", uid, "transaksi");
  unsub = onSnapshot(
    transaksiRef,
    (snap) => {
      semua = snap.docs
        .map((d) => ({
          id: d.id,
          ...d.data({ serverTimestamps: "estimate" }),
        }))
        .sort(urutTerbaru);
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

// Hentikan listener
function berhentiListener() {
  if (unsub) {
    unsub();
    unsub = null;
  }
  transaksiRef = null;
  dataSiap = false;
}

// Tampilkan app setelah login
function tampilAplikasi(u) {
  berhentiListener();
  semua = [];
  resetForm();
  resetFilter();
  $("auth").classList.add("is-hidden");
  $("app-shell").classList.remove("is-hidden");
  $("user-email").textContent = u.email || "";
  bukaView("beranda");
  renderSemua();
  mulaiListener(u.uid);
}

// Tampilkan halaman login
function tampilAuth() {
  berhentiListener();
  semua = [];
  resetForm();
  resetFilter();
  $("app-shell").classList.add("is-hidden");
  $("auth").classList.remove("is-hidden");
  setMode("login");
}

// Pantau status login
onAuthStateChanged(auth, (u) => (u ? tampilAplikasi(u) : tampilAuth()));

// Tombol navigasi (data-view); membuka Input dari menu = form baru
document.querySelectorAll("[data-view]").forEach((el) =>
  el.addEventListener("click", () => {
    if (el.dataset.view === "input" && editId) resetForm();
    bukaView(el.dataset.view);
  }),
);
// Menu HP
$("btn-menu").addEventListener("click", () =>
  document.querySelector(".sidebar").classList.toggle("open"),
);
// Logo → dashboard
$("brand-home").addEventListener("click", (e) => {
  e.preventDefault();
  bukaView("beranda");
});

const form = $("form-transaksi");
// Cegah scroll mouse mengubah angka di kolom Nominal
form.jumlah.addEventListener("wheel", (e) => e.target.blur());

// Kembalikan form ke mode "transaksi baru"
function resetForm() {
  editId = null;
  form.reset();
  isiKategori();
  $("tanggal").value = isoHariIni();
  $("judul-form").textContent = "Transaksi Baru";
  $("btn-simpan").textContent = "Simpan";
  $("btn-batal").classList.add("is-hidden");
}

// Isi form dengan data transaksi lama, lalu buka halaman Input (mode edit)
function mulaiEdit(t) {
  const info = KATEGORI[t.kategori];
  editId = t.id;
  $("jenis").value = info?.jenis || t.jenis || "debit";
  isiKategori();
  if (info) $("kategori").value = t.kategori;
  $("tanggal").value = ymd(t) || isoHariIni();
  form.jumlah.value = t.jumlah;
  form.keterangan.value = t.keterangan || "";
  $("judul-form").textContent = "Edit Transaksi";
  $("btn-simpan").textContent = "Simpan Perubahan";
  $("btn-batal").classList.remove("is-hidden");
  bukaView("input");
}

// Submit form transaksi (baru atau edit)
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!dataSiap) return toast("Data belum selesai dimuat. Coba lagi sebentar.");

  const data = Object.fromEntries(new FormData(form));
  const tombol = $("btn-simpan");
  const edit = !!editId;
  tombol.disabled = true;
  tombol.textContent = "Menyimpan...";
  try {
    await simpanTransaksi(data);
    resetForm();
    resetFilter(); // hapus filter agar transaksi yang disimpan pasti terlihat
    renderRiwayat();
    toast(edit ? "Transaksi diperbarui." : "Transaksi berhasil disimpan.");
    bukaView(edit ? "riwayat" : "beranda");
  } catch (err) {
    console.error(err);
    toast(err.message || "Transaksi gagal disimpan.");
  } finally {
    tombol.disabled = false;
    tombol.textContent = editId ? "Simpan Perubahan" : "Simpan";
  }
});

// Batal edit
$("btn-batal").addEventListener("click", () => {
  resetForm();
  bukaView("riwayat");
});

// Inisialisasi awal
["cari", "filter-dari", "filter-sampai"].forEach((id) =>
  $(id).addEventListener("input", renderRiwayat),
);
$("btn-reset-filter").addEventListener("click", () => {
  resetFilter();
  renderRiwayat();
});
// Ganti tema terang/gelap (pilihan disimpan di browser)
$("btn-tema").addEventListener("click", () => {
  const t = document.documentElement.dataset.tema === "dark" ? "light" : "dark";
  document.documentElement.dataset.tema = t;
  localStorage.setItem("tema", t);
});
$("jenis").addEventListener("change", isiKategori);
isiKategori();
$("tanggal").value = isoHariIni();
$("tanggal-hari").textContent = new Date().toLocaleDateString("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

// Tutup splash screen
function tutupSplash() {
  const splash = $("splash");
  if (!splash || splash.classList.contains("leaving")) return;
  splash.classList.add("leaving");
  setTimeout(() => splash.remove(), 700);
}
setTimeout(tutupSplash, 1900);
