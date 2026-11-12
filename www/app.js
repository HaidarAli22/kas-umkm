// ---------- 1. IMPORT FIREBASE ----------
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

// ---------- 2. KONFIGURASI FIREBASE ----------
const firebaseConfig = {
  apiKey: "AIzaSyCIyjHyaaQ1E5NnzKtVhTGXxM5fIhbKTGw",
  authDomain: "kas-umkm-fd883.firebaseapp.com",
  projectId: "kas-umkm-fd883",
  storageBucket: "kas-umkm-fd883.firebasestorage.app",
  messagingSenderId: "351453490532",
  appId: "1:351453490532:web:9e8a3e176adf1e0cb7de71",
};

// Menghubungkan aplikasi ke Firebase (database dan login)
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Fungsi singkat untuk mengambil elemen HTML berdasarkan id
function $(id) {
  return document.getElementById(id);
}

// ---------- 3. VARIABEL GLOBAL ----------
let semua = []; // menyimpan semua data transaksi
let dataSiap = false; // true jika data dari Firebase sudah selesai dimuat
let toastTimer; // timer untuk menghilangkan notifikasi
let transaksiRef = null; // lokasi koleksi transaksi milik user di Firebase
let unsub = null; // fungsi untuk menghentikan listener data
let editId = null; // id transaksi yang sedang diedit (null = mode tambah)

// ---------- 4. FUNGSI BANTU (FORMAT & TANGGAL) ----------

// Mengubah angka menjadi format rupiah, contoh: Rp 10.000
function rupiah(n) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);
}

// Mengubah tanggal menjadi teks format YYYY-MM-DD (sesuai zona waktu lokal)
function isoDari(d) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}

// Mengambil tanggal hari ini dalam format YYYY-MM-DD
function isoHariIni() {
  return isoDari(new Date());
}

// Mengambil tanggal dari data transaksi menjadi objek Date (null jika tidak valid)
function tanggalObj(t) {
  let d = null;
  if (t.tanggal && t.tanggal.toDate) {
    d = t.tanggal.toDate(); // tanggal bertipe Timestamp Firebase
  } else if (t.tanggal) {
    d = new Date(t.tanggal);
  }
  if (d && !Number.isNaN(d.getTime())) {
    return d;
  }
  return null;
}

// Mengambil tanggal transaksi dalam format YYYY-MM-DD
function ymd(t) {
  const d = tanggalObj(t);
  if (d) {
    return isoDari(d);
  }
  return "";
}

// Membuat kode HTML ikon SVG berdasarkan nama ikon
function svgIkon(nama) {
  return `<svg class="ikon"><use href="#i-${nama}" /></svg>`;
}

// Mengubah tanggal transaksi menjadi teks, contoh: 5 Jan 2025
function tanggalTeks(t) {
  const d = tanggalObj(t);
  if (!d) {
    return "—";
  }
  return d.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Mengubah waktu (Timestamp / tanggal) menjadi angka milidetik untuk pengurutan
function waktu(ts) {
  if (ts && ts.toMillis) {
    return ts.toMillis();
  }
  if (ts) {
    return new Date(ts).getTime() || 0;
  }
  return 0;
}

// Pengurutan: tanggal terbaru dulu, jika sama maka yang dibuat paling akhir
function urutTerbaru(a, b) {
  return (
    waktu(b.tanggal) - waktu(a.tanggal) ||
    waktu(b.dibuatPada) - waktu(a.dibuatPada)
  );
}

// ---------- 5. DATA KATEGORI TRANSAKSI ----------
// jenis = debit/kredit, angka 1 / -1 / 0 menunjukkan pengaruh ke tiap akun
// kas = saldo kas, modal, pendapatan, beban, piutang, utang
const KATEGORI = {
  "Penambahan Modal": { jenis: "debit", kas: 1, modal: 1 },
  "Penarikan Modal": { jenis: "kredit", kas: -1, modal: -1 },
  Penjualan: { jenis: "debit", kas: 1, pendapatan: 1 },
  Piutang: { jenis: "debit", kas: 0, piutang: 1 },
  "Terima Piutang": { jenis: "debit", kas: 1, piutang: -1, pendapatan: 1 },
  Kulakan: { jenis: "kredit", kas: -1, beban: 1 },
  "Biaya Operasional": { jenis: "kredit", kas: -1, beban: 1 },
  Utang: { jenis: "kredit", kas: 0, utang: 1 },
  "Bayar Utang": { jenis: "kredit", kas: -1, utang: -1, beban: 1 },
};

// Mengisi pilihan kategori sesuai jenis (debit/kredit) yang dipilih
function isiKategori() {
  const jenis = $("jenis").value;
  const kategori = $("kategori");
  kategori.innerHTML = "";

  const semuaNama = Object.keys(KATEGORI);
  for (let i = 0; i < semuaNama.length; i++) {
    const nama = semuaNama[i];
    if (KATEGORI[nama].jenis === jenis) {
      const o = document.createElement("option");
      o.value = nama;
      o.textContent = nama;
      kategori.appendChild(o);
    }
  }
}

// ---------- 6. FUNGSI PERHITUNGAN ----------

// Menghitung pengaruh satu transaksi terhadap saldo kas
// (positif = uang masuk, negatif = uang keluar, 0 = hanya catatan)
function nilaiKas(t) {
  const info = KATEGORI[t.kategori];
  const j = Number(t.jumlah) || 0;
  if (info) {
    return (info.kas || 0) * j;
  }
  if (t.jenis === "debit") {
    return j;
  }
  if (t.jenis === "kredit") {
    return -j;
  }
  return 0;
}

// Menjumlahkan satu akun dari semua transaksi (contoh: "modal", "utang", "piutang")
function totalProperti(prop) {
  let total = 0;
  for (let i = 0; i < semua.length; i++) {
    const t = semua[i];
    const info = KATEGORI[t.kategori];
    if (info && info[prop]) {
      total += info[prop] * (Number(t.jumlah) || 0);
    }
  }
  return total;
}

// ---------- 7. VALIDASI & SIMPAN DATA ----------

// Memeriksa input form, jika salah akan menampilkan pesan error
function validasi(data) {
  const jumlah = Number(data.jumlah);
  if (!Number.isSafeInteger(jumlah) || jumlah <= 0) {
    throw new Error("Nominal harus berupa bilangan bulat positif.");
  }

  const info = KATEGORI[data.kategori];
  if (!info || info.jenis !== data.jenis) {
    throw new Error("Kategori tidak sesuai dengan jenis transaksi.");
  }

  if (!data.tanggal) {
    throw new Error("Tanggal harus diisi.");
  }
  const tanggal = new Date(`${data.tanggal}T00:00:00`);
  if (Number.isNaN(tanggal.getTime())) {
    throw new Error("Tanggal tidak valid.");
  }

  // Mengembalikan data yang sudah bersih dan siap disimpan
  return {
    jenis: data.jenis,
    kategori: data.kategori,
    tanggal: Timestamp.fromDate(tanggal),
    jumlah: jumlah,
    keterangan: String(data.keterangan || "").trim(),
  };
}

// Menyimpan transaksi ke Firebase (tambah baru atau update jika sedang edit)
async function simpanTransaksi(data) {
  if (!transaksiRef) {
    throw new Error("Sesi berakhir, silakan masuk lagi.");
  }
  const isi = validasi(data);

  if (editId) {
    // Mode edit: perbarui data yang sudah ada
    await updateDoc(doc(transaksiRef, editId), isi);
  } else {
    // Mode tambah: buat data baru + catat waktu pembuatan
    isi.dibuatPada = serverTimestamp();
    await addDoc(transaksiRef, isi);
  }
}

// ---------- 8. NOTIFIKASI & POP UP ----------

// Menampilkan notifikasi kecil selama 3 detik
function toast(pesan) {
  const el = $("toast");
  el.textContent = pesan;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    el.classList.remove("show");
  }, 3000);
}

// Menampilkan pop up konfirmasi, hasilnya true (Ya) atau false (Batal)
function showConfirm(title, message) {
  return new Promise(function (resolve) {
    $("modal-title").textContent = title;
    $("modal-message").textContent = message;
    $("confirm-modal").classList.remove("is-hidden");

    // Dijalankan saat tombol Ya diklik
    function handleConfirm() {
      tutup();
      resolve(true);
    }
    // Dijalankan saat tombol Batal diklik
    function handleCancel() {
      tutup();
      resolve(false);
    }
    // Menutup pop up dan melepas event klik
    function tutup() {
      $("confirm-modal").classList.add("is-hidden");
      $("modal-confirm").removeEventListener("click", handleConfirm);
      $("modal-cancel").removeEventListener("click", handleCancel);
    }

    $("modal-confirm").addEventListener("click", handleConfirm);
    $("modal-cancel").addEventListener("click", handleCancel);
  });
}

// ---------- 9. PINDAH HALAMAN ----------

// Menampilkan satu halaman (beranda / input / riwayat) dan menyembunyikan lainnya
function bukaView(nama) {
  const views = document.querySelectorAll(".view");
  for (let i = 0; i < views.length; i++) {
    views[i].classList.toggle("active", views[i].id === `view-${nama}`);
  }

  const menus = document.querySelectorAll(".nav-item");
  for (let i = 0; i < menus.length; i++) {
    menus[i].classList.toggle("active", menus[i].dataset.view === nama);
  }

  $("sidebar").classList.remove("open"); // tutup sidebar (untuk HP)
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- 10. FUNGSI TAMPILAN TABEL ----------

// Menentukan teks jenis transaksi: Debit / Kredit / Catatan
function jenisTeks(t) {
  const k = nilaiKas(t);
  if (k > 0) return "Debit";
  if (k < 0) return "Kredit";
  return "Catatan";
}

// Menentukan teks nominal beserta warnanya (hijau masuk, merah keluar)
function nominalTeks(t) {
  const k = nilaiKas(t);
  if (k > 0) {
    return { teks: `+ ${rupiah(t.jumlah)}`, kelas: "amount-in" };
  }
  if (k < 0) {
    return { teks: `− ${rupiah(t.jumlah)}`, kelas: "amount-out" };
  }
  return { teks: rupiah(t.jumlah), kelas: "" };
}

// Menentukan class untuk kolom nominal (rata kanan)
function kelasNum(k) {
  if (k) {
    return k + " col-num";
  }
  return "col-num";
}

// Membuat satu sel tabel (td) berisi teks
function sel(teks, kelas) {
  const td = document.createElement("td");
  td.textContent = teks;
  if (kelas) {
    td.className = kelas;
  }
  return td;
}

// Menampilkan baris kosong di tabel (contoh: "Belum ada transaksi")
function kosong(tbody, kolom, pesan) {
  const td = sel(pesan || "Belum ada transaksi", "empty-cell");
  td.colSpan = kolom;
  const tr = document.createElement("tr");
  tr.appendChild(td);
  tbody.innerHTML = "";
  tbody.appendChild(tr);
}

// Membuat sel nama transaksi (ikon + kategori + keterangan)
function selNama(t) {
  const k = nilaiKas(t);
  let ikon = "minus";
  if (k > 0) ikon = "arrow-up-right";
  if (k < 0) ikon = "arrow-down-right";

  const td = document.createElement("td");
  td.innerHTML = `<div class="transaction-name"><span class="transaction-symbol">${svgIkon(ikon)}</span><div><strong></strong><small></small></div></div>`;
  td.querySelector("strong").textContent = t.kategori || "Transaksi";
  td.querySelector("small").textContent = t.keterangan || "—";
  return td;
}

// Membuat satu baris tabel berisi: nama, tanggal, jenis, nominal
function buatBaris(t) {
  const tr = document.createElement("tr");
  const n = nominalTeks(t);
  tr.appendChild(selNama(t));
  tr.appendChild(sel(tanggalTeks(t)));
  tr.appendChild(sel(jenisTeks(t)));
  tr.appendChild(sel(n.teks, kelasNum(n.kelas)));
  return tr;
}

// ---------- 11. RENDER (MENAMPILKAN DATA KE LAYAR) ----------

// Menampilkan 5 transaksi terbaru di dashboard
function renderTerbaru() {
  const tbody = $("transaksi-terbaru");
  const list = semua.slice(0, 5);

  if (list.length === 0) {
    kosong(tbody, 4);
    return;
  }

  tbody.innerHTML = "";
  for (let i = 0; i < list.length; i++) {
    tbody.appendChild(buatBaris(list[i]));
  }
}

// Mengosongkan kolom pencarian dan filter tanggal
function resetFilter() {
  $("cari").value = "";
  $("filter-dari").value = "";
  $("filter-sampai").value = "";
}

// Membuat tombol edit untuk satu transaksi
function buatTombolEdit(t) {
  const edit = document.createElement("button");
  edit.className = "edit-button";
  edit.type = "button";
  edit.innerHTML = svgIkon("pencil");
  edit.setAttribute("aria-label", "Edit transaksi");

  edit.addEventListener("click", async function () {
    const yakin = await showConfirm(
      "Edit Transaksi",
      `Edit data "${t.kategori}" sebesar ${rupiah(t.jumlah)}?`,
    );
    if (yakin) {
      mulaiEdit(t);
    }
  });
  return edit;
}

// Membuat tombol hapus untuk satu transaksi
function buatTombolHapus(t) {
  const hapus = document.createElement("button");
  hapus.className = "delete-button";
  hapus.type = "button";
  hapus.innerHTML = svgIkon("x");
  hapus.setAttribute("aria-label", "Hapus transaksi");

  hapus.addEventListener("click", async function () {
    const yakin = await showConfirm(
      "Hapus Transaksi",
      `Hapus "${t.kategori}" sebesar ${rupiah(t.jumlah)}?`,
    );
    if (!yakin) {
      return;
    }
    hapus.disabled = true;
    try {
      await deleteDoc(doc(transaksiRef, t.id));
      toast("Transaksi dihapus.");
    } catch (err) {
      toast(`Gagal menghapus: ${err.message}`);
      hapus.disabled = false;
    }
  });
  return hapus;
}

// Menampilkan semua transaksi di halaman riwayat (dengan pencarian & filter)
function renderRiwayat() {
  const tbody = $("daftar-riwayat");
  const kata = $("cari").value.trim().toLocaleLowerCase("id-ID");
  const dari = $("filter-dari").value;
  const sampai = $("filter-sampai").value;

  // Menyaring data sesuai kata pencarian dan rentang tanggal
  const list = [];
  for (let i = 0; i < semua.length; i++) {
    const t = semua[i];
    const tgl = ymd(t);

    const cocokDari = !dari || (tgl && tgl >= dari);
    const cocokSampai = !sampai || (tgl && tgl <= sampai);
    const teksCari = [t.kategori, t.keterangan, jenisTeks(t)]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("id-ID");
    const cocokKata = teksCari.includes(kata);

    if (cocokDari && cocokSampai && cocokKata) {
      list.push(t);
    }
  }

  // Menghitung total masuk, keluar, dan selisih dari data yang tampil
  let masuk = 0;
  let keluar = 0;
  for (let i = 0; i < list.length; i++) {
    const k = nilaiKas(list[i]);
    if (k > 0) masuk += k;
    if (k < 0) keluar += -k;
  }
  $("sum-masuk").textContent = rupiah(masuk);
  $("sum-keluar").textContent = rupiah(keluar);
  $("sum-bersih").textContent = rupiah(masuk - keluar);
  $("jumlah-riwayat").textContent = `${list.length} transaksi`;

  // Jika tidak ada data, tampilkan pesan kosong
  if (list.length === 0) {
    if (kata || dari || sampai) {
      kosong(tbody, 5, "Tidak ada transaksi yang cocok");
    } else {
      kosong(tbody, 5, "Belum ada transaksi");
    }
    return;
  }

  // Menampilkan setiap baris + tombol edit dan hapus
  tbody.innerHTML = "";
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const tr = buatBaris(t);

    const aksi = document.createElement("div");
    aksi.className = "row-actions";
    aksi.appendChild(buatTombolEdit(t));
    aksi.appendChild(buatTombolHapus(t));

    const tdAksi = document.createElement("td");
    tdAksi.appendChild(aksi);
    tr.appendChild(tdAksi);

    tbody.appendChild(tr);
  }
}

// Menampilkan angka-angka dan grafik donat di dashboard
function renderDashboard() {
  // Saldo kas = jumlah pengaruh kas semua transaksi
  let saldo = 0;
  let masuk = 0;
  let keluar = 0;
  for (let i = 0; i < semua.length; i++) {
    const k = nilaiKas(semua[i]);
    saldo += k;
    if (k > 0) masuk += k;
    if (k < 0) keluar += -k;
  }
  $("saldo").textContent = rupiah(saldo);
  $("modal").textContent = rupiah(totalProperti("modal"));

  // Laba rugi = pendapatan - beban (positif = laba, negatif = rugi)
  const labaRugi = totalProperti("pendapatan") - totalProperti("beban");
  $("laba").textContent = rupiah(Math.max(labaRugi, 0));
  $("rugi").textContent = rupiah(Math.max(-labaRugi, 0));

  // Grafik donat: persentase uang masuk dibanding total arus kas
  const total = masuk + keluar;
  let persen = 0;
  if (total) {
    persen = Math.round((masuk / total) * 100);
  }
  if (total) {
    $("pie").style.background =
      `conic-gradient(var(--green) 0% ${persen}%, var(--line) ${persen}% 100%)`;
  } else {
    $("pie").style.background = "conic-gradient(var(--line) 0% 100%)";
  }

  $("total-arus").textContent = rupiah(total);
  $("total-masuk").textContent = rupiah(masuk);
  $("total-keluar").textContent = rupiah(keluar);
  $("total-utang").textContent = rupiah(totalProperti("utang"));
  $("total-piutang").textContent = rupiah(totalProperti("piutang"));
}

// Menjalankan semua tampilan sekaligus
function renderSemua() {
  renderDashboard();
  renderTerbaru();
  renderRiwayat();
}

// ---------- 12. LOGIN & DAFTAR ----------
let modeAuth = "login"; // "login" atau "register"

// Menampilkan pesan di halaman login (merah jika error)
function pesanAuth(teks, error) {
  if (error === undefined) {
    error = true;
  }
  const el = $("auth-pesan");
  el.textContent = teks;
  el.classList.toggle("error", error && !!teks);
}

// Mengganti mode antara Masuk dan Daftar
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
  $("form-auth").reset();
  pesanAuth("");

  // Mengulang animasi perpindahan form
  const f = $("form-auth");
  f.classList.remove("switch-anim");
  void f.offsetWidth;
  f.classList.add("switch-anim");
}

// Mengubah kode error Firebase menjadi pesan bahasa Indonesia
function pesanError(code) {
  const daftarPesan = {
    "auth/invalid-email": "Format email tidak valid.",
    "auth/email-already-in-use": "Email sudah terdaftar. Silakan masuk.",
    "auth/weak-password": "Kata sandi minimal 6 karakter.",
    "auth/invalid-credential": "Email atau kata sandi salah.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi nanti.",
    "auth/network-request-failed": "Gagal terhubung. Periksa koneksi internet.",
  };
  if (daftarPesan[code]) {
    return daftarPesan[code];
  }
  return `Terjadi kesalahan${code ? ` (${code})` : ""}. Coba lagi.`;
}

// Tombol tab Masuk dan Daftar
$("tab-login").addEventListener("click", function () {
  setMode("login");
});
$("tab-register").addEventListener("click", function () {
  setMode("register");
});

// Saat form login/daftar dikirim
$("form-auth").addEventListener("submit", async function (e) {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const sandi = $("auth-password").value;

  // Saat daftar, kata sandi harus sama dengan konfirmasinya
  if (modeAuth === "register" && sandi !== $("auth-konfirmasi").value) {
    pesanAuth("Konfirmasi kata sandi tidak sama.");
    return;
  }

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

// Tombol keluar (logout) dengan pop up konfirmasi
$("btn-logout").addEventListener("click", async function () {
  const yakin = await showConfirm(
    "Keluar",
    "Apakah Anda yakin ingin keluar dari aplikasi?",
  );
  if (yakin) {
    await signOut(auth);
  }
});

// ---------- 13. MENGAMBIL DATA DARI FIREBASE ----------

// Mulai memantau data transaksi milik user (otomatis update jika ada perubahan)
function mulaiListener(uid) {
  transaksiRef = collection(db, "tokos", uid, "transaksi");

  unsub = onSnapshot(
    transaksiRef,
    function (snap) {
      // Data berhasil diambil
      semua = [];
      snap.docs.forEach(function (d) {
        const isi = d.data({ serverTimestamps: "estimate" });
        isi.id = d.id;
        semua.push(isi);
      });
      semua.sort(urutTerbaru);
      dataSiap = true;
      renderSemua();
    },
    function (err) {
      // Data gagal diambil
      console.error("Firebase Firestore error:", err);
      dataSiap = false;
      toast("Tidak dapat memuat data dari Firebase.");
    },
  );
}

// Berhenti memantau data (dipakai saat logout)
function berhentiListener() {
  if (unsub) {
    unsub();
    unsub = null;
  }
  transaksiRef = null;
  dataSiap = false;
}

// ---------- 14. TAMPILKAN APLIKASI / HALAMAN LOGIN ----------

// Dijalankan saat user berhasil login
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

// Dijalankan saat user belum login / sudah logout
function tampilAuth() {
  berhentiListener();
  semua = [];
  resetForm();
  resetFilter();
  $("app-shell").classList.add("is-hidden");
  $("auth").classList.remove("is-hidden");
  setMode("login");
}

// Memantau status login: otomatis pindah tampilan
onAuthStateChanged(auth, function (u) {
  if (u) {
    tampilAplikasi(u);
  } else {
    tampilAuth();
  }
});

// ---------- 15. NAVIGASI ----------

// Semua tombol yang punya atribut data-view akan pindah halaman saat diklik
const tombolView = document.querySelectorAll("[data-view]");
for (let i = 0; i < tombolView.length; i++) {
  tombolView[i].addEventListener("click", function () {
    const el = tombolView[i];
    // Jika pindah ke halaman input saat mode edit, batalkan edit
    if (el.dataset.view === "input" && editId) {
      resetForm();
    }
    bukaView(el.dataset.view);
  });
}

// Tombol menu (hamburger) untuk membuka/menutup sidebar di HP
$("btn-menu").addEventListener("click", function () {
  document.querySelector(".sidebar").classList.toggle("open");
});

// Klik logo untuk kembali ke dashboard
$("brand-home").addEventListener("click", function (e) {
  e.preventDefault();
  bukaView("beranda");
});

// ---------- 16. FORM TRANSAKSI ----------
const form = $("form-transaksi");

// Mencegah angka berubah saat mouse di-scroll di kolom nominal
form.jumlah.addEventListener("wheel", function (e) {
  e.target.blur();
});

// Mengembalikan form ke kondisi awal (mode tambah)
function resetForm() {
  editId = null;
  form.reset();
  isiKategori();
  $("tanggal").value = isoHariIni();
  $("judul-form").textContent = "Transaksi Baru";
  $("btn-simpan").textContent = "Simpan";
  $("btn-batal").classList.add("is-hidden");
}

// Mengisi form dengan data transaksi yang akan diedit
function mulaiEdit(t) {
  const info = KATEGORI[t.kategori];
  editId = t.id;

  // Mengatur jenis (debit/kredit)
  if (info && info.jenis) {
    $("jenis").value = info.jenis;
  } else {
    $("jenis").value = t.jenis || "debit";
  }
  isiKategori();
  if (info) {
    $("kategori").value = t.kategori;
  }

  $("tanggal").value = ymd(t) || isoHariIni();
  form.jumlah.value = t.jumlah;
  form.keterangan.value = t.keterangan || "";
  $("judul-form").textContent = "Edit Transaksi";
  $("btn-simpan").textContent = "Simpan Perubahan";
  $("btn-batal").classList.remove("is-hidden");
  bukaView("input");
}

// Saat tombol Simpan diklik
form.addEventListener("submit", async function (e) {
  e.preventDefault();

  if (!dataSiap) {
    toast("Data belum selesai dimuat. Coba lagi sebentar.");
    return;
  }

  const data = Object.fromEntries(new FormData(form));
  const tombol = $("btn-simpan");
  const edit = !!editId; // true jika sedang mode edit
  tombol.disabled = true;
  tombol.textContent = "Menyimpan...";

  try {
    await simpanTransaksi(data);
    resetForm();
    resetFilter();
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

// Tombol Batal saat edit: kembali ke riwayat
$("btn-batal").addEventListener("click", function () {
  resetForm();
  bukaView("riwayat");
});

// ---------- 17. PENCARIAN & FILTER RIWAYAT ----------

// Setiap kali kolom cari / tanggal berubah, tabel riwayat diperbarui
["cari", "filter-dari", "filter-sampai"].forEach(function (id) {
  $(id).addEventListener("input", renderRiwayat);
});

// Tombol Reset filter
$("btn-reset-filter").addEventListener("click", function () {
  resetFilter();
  renderRiwayat();
});

// ---------- 18. GANTI TEMA ----------

// Tombol ganti tema terang/gelap, pilihan disimpan di localStorage
$("btn-tema").addEventListener("click", function () {
  let t = "dark";
  if (document.documentElement.dataset.tema === "dark") {
    t = "light";
  }
  document.documentElement.dataset.tema = t;
  localStorage.setItem("tema", t);
});

// ---------- 19. PENGATURAN AWAL SAAT APLIKASI DIBUKA ----------
$("jenis").addEventListener("change", isiKategori); // ganti kategori saat jenis berubah
isiKategori();
$("tanggal").value = isoHariIni();
$("tanggal-hari").textContent = new Date().toLocaleDateString("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

// ---------- 20. SPLASH SCREEN ----------

// Menutup splash screen dengan efek menghilang
function tutupSplash() {
  const splash = $("splash");
  if (!splash || splash.classList.contains("leaving")) {
    return;
  }
  splash.classList.add("leaving");
  setTimeout(function () {
    splash.remove();
  }, 700);
}
setTimeout(tutupSplash, 1900); // splash tampil selama 1,9 detik
