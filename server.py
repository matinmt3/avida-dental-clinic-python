#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
سرور بک‌اند و API کامل «مطب دندانپزشکی آویدا» (Avida Dental Clinic)
پشتیبانی از پایگاه داده پایدار SQLite، احراز هویت امن PBKDF2، کنترل سطح دسترسی،
تقویم شمسی، محاسبه ظرفیت نوبت با لحاظ مدت خدمت و فاصله ضدعفونی،
و قفل اتمیک پایگاه داده (BEGIN IMMEDIATE) برای جلوگیری از رزرو هم‌زمان.
"""

import datetime
import hashlib
import hmac
import html as html_lib
import http.server
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import urllib.parse
from pathlib import Path

import shutil

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
PERSIST_DB_PATH = DATA_DIR / "avida.db"
RUNTIME_DB_PATH = DATA_DIR / "avida-runtime.db"
DB_PATH = RUNTIME_DB_PATH

DATA_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# تبدیل تقویم میلادی و شمسی (جلالی) و اعداد فارسی
# ---------------------------------------------------------------------------
PERSIAN_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
ENGLISH_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")

JALALI_MONTH_NAMES = [
    "",
    "فروردین",
    "اردیبهشت",
    "خرداد",
    "تیر",
    "مرداد",
    "شهریور",
    "مهر",
    "آبان",
    "آذر",
    "دی",
    "بهمن",
    "اسفند",
]

WEEKDAY_NAMES_FA = [
    "شنبه",
    "یکشنبه",
    "دوشنبه",
    "سه‌شنبه",
    "چهارشنبه",
    "پنجشنبه",
    "جمعه",
]


def to_fa_digits(val) -> str:
    return str(val).translate(PERSIAN_DIGITS)


def to_en_digits(val) -> str:
    return str(val).translate(ENGLISH_DIGITS)


def gregorian_to_jalali(gy: int, gm: int, gd: int):
    g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    if gy > 1600:
        jy = 979
        gy -= 1600
    else:
        jy = 0
        gy -= 621
    gy2 = gy + 1 if gm > 2 else gy
    days = (
        (365 * gy)
        + int((gy2 + 3) / 4)
        - int((gy2 + 99) / 100)
        + int((gy2 + 399) / 400)
        - 80
        + gd
        + g_d_m[gm - 1]
    )
    jy += 33 * int(days / 12053)
    days %= 12053
    jy += 4 * int(days / 1461)
    days %= 1461
    if days > 365:
        jy += int((days - 1) / 365)
        days = (days - 1) % 365
    if days < 186:
        jm = 1 + int(days / 31)
        jd = 1 + (days % 31)
    else:
        jm = 7 + int((days - 186) / 30)
        jd = 1 + ((days - 186) % 30)
    return jy, jm, jd


def jalali_to_gregorian(jy: int, jm: int, jd: int):
    if jy > 979:
        gy = 1600
        jy -= 979
    else:
        gy = 621
    if jm < 7:
        days = (jm - 1) * 31
    else:
        days = ((jm - 7) * 30) + 186
    days += (365 * jy) + (int(jy / 33) * 8) + int(((jy % 33) + 3) / 4) + 78 + jd
    gy += 400 * int(days / 146097)
    days %= 146097
    if days > 36524:
        gy += 100 * int((days - 1) / 36524)
        days = (days - 1) % 36524
        if days >= 365:
            days += 1
    gy += 4 * int(days / 1461)
    days %= 1461
    if days > 365:
        gy += int((days - 1) / 365)
        days = (days - 1) % 365
    gd = days + 1
    sal_a = [
        0,
        31,
        29 if ((gy % 4 == 0 and gy % 100 != 0) or (gy % 400 == 0)) else 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ]
    gm = 0
    while gm < 13 and gd > sal_a[gm]:
        gd -= sal_a[gm]
        gm += 1
    return gy, gm, gd


def parse_jalali_date(j_str: str):
    clean = to_en_digits(j_str.strip()).replace("-", "/")
    parts = clean.split("/")
    if len(parts) != 3:
        raise ValueError("فرمت تاریخ شمسی نامعتبر است (نمونه صحیح: ۱۴۰۵/۰۷/۲۵).")
    jy, jm, jd = int(parts[0]), int(parts[1]), int(parts[2])
    if not (1300 <= jy <= 1500 and 1 <= jm <= 12 and 1 <= jd <= 31):
        raise ValueError("مقادیر تاریخ شمسی خارج از محدوده مجاز است.")
    if jm > 6 and jd == 31:
        raise ValueError("ماه‌های نیمه دوم سال حداکثر ۳۰ روز دارند.")
    gy, gm, gd = jalali_to_gregorian(jy, jm, jd)
    if gregorian_to_jalali(gy, gm, gd) != (jy, jm, jd):
        raise ValueError("تاریخ شمسی واردشده وجود ندارد.")
    return jy, jm, jd, f"{jy:04d}/{jm:02d}/{jd:02d}"


def jalali_weekday_index(j_str: str) -> int:
    """بازگرداندن شماره روز هفته ایرانی: ۰=شنبه، ۱=یکشنبه، ...، ۶=جمعه"""
    jy, jm, jd, _ = parse_jalali_date(j_str)
    gy, gm, gd = jalali_to_gregorian(jy, jm, jd)
    d = datetime.date(gy, gm, gd)
    # Python weekday(): Monday=0 ... Sunday=6 -> Saturday=5
    return (d.weekday() + 2) % 7


def format_jalali_human(j_str: str) -> str:
    try:
        jy, jm, jd, norm = parse_jalali_date(j_str)
        w_idx = jalali_weekday_index(norm)
        return f"{WEEKDAY_NAMES_FA[w_idx]} {to_fa_digits(jd)} {JALALI_MONTH_NAMES[jm]} {to_fa_digits(jy)}"
    except Exception:
        return j_str


def iran_now() -> datetime.datetime:
    # Iran Standard Time UTC+03:30
    tz_iran = datetime.timezone(datetime.timedelta(hours=3, minutes=30))
    return datetime.datetime.now(tz_iran)


def today_jalali_str() -> str:
    now = iran_now()
    jy, jm, jd = gregorian_to_jalali(now.year, now.month, now.day)
    return f"{jy:04d}/{jm:02d}/{jd:02d}"


def time_to_minutes(t_str: str) -> int:
    clean = to_en_digits(t_str.strip())
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", clean):
        raise ValueError("ساعت باید با قالب معتبر ۰۰:۰۰ تا ۲۳:۵۹ وارد شود.")
    hours, minutes = clean.split(":")
    return int(hours) * 60 + int(minutes)


def minutes_to_time(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def jalali_datetime_from_str(j_str: str, t_str: str) -> datetime.datetime:
    jy, jm, jd, _ = parse_jalali_date(j_str)
    gy, gm, gd = jalali_to_gregorian(jy, jm, jd)
    mins = time_to_minutes(t_str)
    tz_iran = datetime.timezone(datetime.timedelta(hours=3, minutes=30))
    return datetime.datetime(gy, gm, gd, mins // 60, mins % 60, tzinfo=tz_iran)


# ---------------------------------------------------------------------------
# امنیت و هش رمز عبور
# ---------------------------------------------------------------------------
def hash_password(password: str, salt: str = None) -> str:
    if not salt:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 120000
    )
    return f"pbkdf2_sha256$120000${salt}${dk.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        parts = stored_hash.split("$")
        if len(parts) != 4:
            return False
        _, iterations, salt, hex_digest = parts
        dk = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            int(iterations),
        )
        return hmac.compare_digest(dk.hex(), hex_digest)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# اتصال به پایگاه داده و مقداردهی اولیه
# ---------------------------------------------------------------------------
DB_LOCK = threading.Lock()


class SyncedConnection(sqlite3.Connection):
    def commit(self):
        super().commit()
        sync_db_to_workspace()

def sync_db_to_workspace():
    try:
        if RUNTIME_DB_PATH.exists():
            shutil.copy2(str(RUNTIME_DB_PATH), str(PERSIST_DB_PATH))
    except Exception:
        pass

def get_db_connection(isolation_level=""):
    if not RUNTIME_DB_PATH.exists() and PERSIST_DB_PATH.exists() and PERSIST_DB_PATH.stat().st_size > 0:
        shutil.copy2(str(PERSIST_DB_PATH), str(RUNTIME_DB_PATH))
    conn = sqlite3.connect(str(RUNTIME_DB_PATH), timeout=30.0, isolation_level=isolation_level, factory=SyncedConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db():
    conn = get_db_connection(isolation_level=None)
    conn.execute("PRAGMA journal_mode = DELETE;")
    cursor = conn.cursor()

    cursor.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'patient',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            identifier TEXT NOT NULL,
            demo_code TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            short_desc TEXT NOT NULL,
            full_desc TEXT NOT NULL,
            duration_min INTEGER NOT NULL DEFAULT 45,
            price_sample TEXT NOT NULL,
            prep_tips TEXT NOT NULL,
            aftercare_tips TEXT NOT NULL,
            model_type TEXT NOT NULL DEFAULT 'implant',
            featured INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS doctors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            specialty TEXT NOT NULL,
            medical_code TEXT NOT NULL,
            bio TEXT NOT NULL,
            experience_note TEXT NOT NULL,
            avatar_theme TEXT NOT NULL DEFAULT 'emerald',
            schedule_json TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tracking_code TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            patient_name TEXT NOT NULL,
            patient_phone TEXT NOT NULL,
            service_id INTEGER NOT NULL,
            doctor_id INTEGER NOT NULL,
            jalali_date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            duration_min INTEGER NOT NULL,
            buffer_min INTEGER NOT NULL DEFAULT 15,
            status TEXT NOT NULL DEFAULT 'confirmed',
            notes TEXT DEFAULT '',
            reschedule_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(service_id) REFERENCES services(id),
            FOREIGN KEY(doctor_id) REFERENCES doctors(id)
        );

        CREATE INDEX IF NOT EXISTS idx_appt_doc_date ON appointments(doctor_id, jalali_date, status);
        CREATE INDEX IF NOT EXISTS idx_appt_user ON appointments(user_id);

        CREATE TABLE IF NOT EXISTS consultations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tracking_code TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            patient_name TEXT NOT NULL,
            patient_phone TEXT NOT NULL,
            service_id INTEGER,
            doctor_id INTEGER,
            subject TEXT NOT NULL,
            urgency TEXT NOT NULL DEFAULT 'عادی',
            status TEXT NOT NULL DEFAULT 'pending',
            unread_by_patient INTEGER NOT NULL DEFAULT 0,
            unread_by_staff INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS consultation_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            consultation_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            sender_role TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS support_tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tracking_code TEXT UNIQUE NOT NULL,
            user_id INTEGER,
            name TEXT NOT NULL,
            contact TEXT NOT NULL,
            subject TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'عمومی',
            status TEXT NOT NULL DEFAULT 'pending',
            unread_by_patient INTEGER NOT NULL DEFAULT 0,
            unread_by_staff INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS support_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER NOT NULL,
            sender_id INTEGER,
            sender_name TEXT NOT NULL,
            sender_role TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'info',
            link_route TEXT NOT NULL DEFAULT '/dashboard',
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS clinic_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS faqs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'عمومی',
            sort_order INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS trash_bin (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            deleted_by TEXT NOT NULL,
            deleted_at TEXT NOT NULL
        );
        """
    )

    # بررسی وجود داده‌های اولیه
    user_count = cursor.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()["cnt"]
    if user_count == 0:
        seed_initial_data(cursor)

    sync_db_to_workspace()
    conn.close()


def seed_initial_data(cursor):
    now_iso = iran_now().isoformat()
    today_j = today_jalali_str()
    jy, jm, jd, _ = parse_jalali_date(today_j)
    gy, gm, gd = jalali_to_gregorian(jy, jm, jd)
    base_date = datetime.date(gy, gm, gd)

    def offset_jalali(days_offset: int) -> str:
        target = base_date + datetime.timedelta(days=days_offset)
        ty, tm, td = gregorian_to_jalali(target.year, target.month, target.day)
        return f"{ty:04d}/{tm:02d}/{td:02d}"

    # ۱. کاربران آزمایشی
    users_seed = [
        (
            "دکتر کیانوش آویدا (صاحب مطب)",
            "09120000001",
            "admin@avidadental.ir",
            hash_password("AvidaAdmin@1405"),
            "admin",
            now_iso,
        ),
        (
            "دکتر آرمان فرهمند (پزشک مطب)",
            "09120000002",
            "dr.farahmand@avidadental.ir",
            hash_password("AvidaDoc@1405"),
            "doctor",
            now_iso,
        ),
        (
            "سارا مرادی (مراجع آزمایشی)",
            "09121112233",
            "sara.moradi@example.ir",
            hash_password("AvidaUser@1405"),
            "patient",
            now_iso,
        ),
    ]
    cursor.executemany(
        "INSERT INTO users (name, phone, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        users_seed,
    )

    # ۲. خدمات مطب (داده‌های نمونه فارسی با اعلام شفاف هزینه نمونه)
    services_seed = [
        (
            "digital-implant",
            "ایمپلنت دیجیتال و بازسازی سه‌بعدی",
            "جراحی و ایمپلنت",
            "جایگزینی دقیق دندان از دست‌رفته با هدایت دیجیتال سه‌بعدی (Surgical Guide) و کمترین آسیب بافتی.",
            "در مطب دندان‌پزشکی آویدا، کاشت ایمپلنت با اسکن داخل‌دهانی سه‌بعدی و طراحی شابلون جراحی دیجیتال انجام می‌شود. این روش باعث دقت بالا در زاویه کاشت پایه تیتانیومی، کاهش چشمگیر التهاب پس از جلسه و تطابق طبیعی روکش سرامیکی با خط لبخند می‌شود. (توجه: هزینه‌های درج‌شده نمونه آزمایشی بوده و پس از معاینه بالینی و بررسی اسکن فک تعیین می‌گردد.)",
            60,
            "۱۴,۵۰۰,۰۰۰ تا ۱۸,۵۰۰,۰۰۰ تومان (نمونه هر واحد)",
            "همراه داشتن تصویر رادیوگرافی یا CBCT اخیر (در صورت وجود)، اطلاع‌رسانی درباره داروهای مصرفی و پرهیز از ناشتا بودن قبل از جلسه.",
            "استفاده از کمپرس سرد در ۲۴ ساعت اول، پرهیز از غذاهای داغ و سفت تا ۴۸ ساعت، و رعایت دقیق بهداشت دهان طبق دستور پزشک.",
            "implant",
            1,
            1,
        ),
        (
            "ceramic-laminate-smile-design",
            "طراحی لبخند دیجیتال و لمینت سرامیکی",
            "زیبایی و ترمیمی",
            "شبیه‌سازی سه‌بعدی لبخند پیش از شروع کار و ساخت پوسته‌های ظریف سرامیکی با درخشش طبیعی مینای دندان.",
            "طراحی لبخند دیجیتال (DSD) به شما امکان می‌دهد پیش از هرگونه اقدام روی دندان‌ها، فرم و تناسب لبخند نهایی را متناسب با اجزای چهره مشاهده کنید. لمینت‌های سرامیکی با حداقل تراش ممکن و شفافیت مشابه مینای طبیعی ساخته می‌شوند تا زیبایی و سلامت بافت دندان هم‌زمان حفظ گردد.",
            60,
            "۹,۸۰۰,۰۰۰ تا ۱۲,۸۰۰,۰۰۰ تومان (نمونه هر واحد)",
            "انجام جرم‌گیری یا بررسی سلامت لثه پیش از قالب‌گیری دیجیتال و مشخص کردن رنگ و فرم مطلوب در جلسه مشاوره.",
            "پرهیز از شکستن خوراکی‌های بسیار سخت با دندان‌های جلو، استفاده از نخ دندان روزانه و مراجعه دوره‌ای هر ۶ ماه.",
            "laminate",
            1,
            1,
        ),
        (
            "invisible-orthodontics",
            "ارتودنسی شفاف و نامرئی (الاینر دیجیتال)",
            "ارتودنسی",
            "مرتب‌سازی دندان‌ها با پلاک‌های شفاف متحرک و طراحی مرحله‌به‌مرحله حرکت دندان در فضای سه‌بعدی.",
            "الاینرهای شفاف گزینه‌ای مدرن و راحت برای اصلاح نامرتبی‌های دندانی بدون براکت و سیم‌های فلزی هستند. پلاک‌ها بر اساس اسکن سه‌بعدی فک ساخته شده و هنگام غذا خوردن یا مسواک زدن به‌راحتی برداشته می‌شوند.",
            45,
            "۳۸,۰۰۰,۰۰۰ تا ۵۴,۰۰۰,۰۰۰ تومان (نمونه دوره درمان)",
            "ترمیم پوسیدگی‌های احتمالی پیش از شروع قالب‌گیری سه‌بعدی و تهیه تصاویر رادیوگرافی اولیه.",
            "استفاده مداوم حداقل ۲۰ تا ۲۲ ساعت در شبانه‌روز از پلاک شفاف و شست‌وشوی پلاک با آب ولرم.",
            "ortho",
            1,
            1,
        ),
        (
            "microscopic-root-canal",
            "درمان ریشه تخصصی با بزرگ‌نمایی (اندو)",
            "درمان ریشه",
            "پاک‌سازی دقیق کانال‌های ظریف ریشه با بزرگ‌نمایی اپتیکال و دستگاه‌های روتاری مدرن در محیطی آرام.",
            "استفاده از بزرگ‌نمایی دقیق و سیستم‌های اندازه‌گیری الکترونیکی طول کانال (اپکس فایندر) دقت پاک‌سازی ریشه را افزایش داده و احتمال نیاز به درمان مجدد را به حداقل می‌رساند. کنترل کامل بی‌حسی موضعی اولویت اصلی ما برای تجربه بدون استرس مراجع است.",
            60,
            "۵,۲۰۰,۰۰۰ تا ۷,۹۰۰,۰۰۰ تومان (نمونه بسته به تعداد کانال)",
            "مصرف بهنگام وعده غذایی سبک پیش از نوبت و اطلاع به پزشک در صورت وجود حساسیت دارویی.",
            "خودداری از جویدن غذاهای سفت با دندان درمان‌شده تا زمان قرارگیری ترمیم نهایی یا روکش محافظ.",
            "endo",
            1,
            1,
        ),
        (
            "laser-bleaching",
            "سفیدکردن دندان با لیزر و کیت خانگی (بلیچینگ)",
            "زیبایی و پیشگیری",
            "روشن‌سازی ایمن رنگ دندان‌ها در یک جلسه با محافظت کامل از بافت لثه و مینای دندان.",
            "بلیچینگ تخصصی در مطب با ژل‌های استاندارد دارای نیترات پتاسیم و فلوراید انجام می‌شود تا ضمن بازگرداندن درخشندگی طبیعی دندان‌ها، حساسیت دندانی به حداقل برسد.",
            45,
            "۶,۴۰۰,۰۰۰ تا ۸,۲۰۰,۰۰۰ تومان (نمونه دو فک)",
            "انجام برساژ و پاک‌سازی پلاک‌های سطحی پیش از شروع جلسه بلیچینگ.",
            "پرهیز از مصرف نوشیدنی‌های رنگ‌دانه‌دار (قهوه، چای پررنگ، نوشابه) در ۴۸ ساعت نخست پس از جلسه.",
            "bleaching",
            1,
            1,
        ),
        (
            "pediatric-preventive-care",
            "دندان‌پزشکی پیشگیرانه و اختصاصی کودکان",
            "کودکان و پیشگیری",
            "فلورایدتراپی، فیشورسیلنت (شیارپوشی) و درمان‌های بدون ترس در محیطی دوستانه برای کودکان.",
            "آشنایی دلپذیر کودک با محیط دندان‌پزشکی، پایه‌گذار سلامت دهان در بزرگسالی است. در بخش کودکان مطب آویدا، خدمات پیشگیرانه شامل شیارپوشی دندان‌های دائمی تازه روییده و آموزش تعاملی مسواک زدن با حوصله و آرامش انجام می‌شود.",
            30,
            "۲,۲۰۰,۰۰۰ تا ۳,۸۰۰,۰۰۰ تومان (نمونه هر جلسه)",
            "گفت‌وگوی مثبت با کودک پیش از مراجعه و پرهیز از به کار بردن واژه‌های نگران‌کننده.",
            "تشویق کودک پس از ویزیت و پرهیز از خوردن و آشامیدن تا ۳۰ دقیقه پس از فلورایدتراپی.",
            "pediatric",
            1,
            1,
        ),
    ]
    cursor.executemany(
        """
        INSERT INTO services (
            slug, title, category, short_desc, full_desc, duration_min,
            price_sample, prep_tips, aftercare_tips, model_type, featured, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        services_seed,
    )

    # ۳. پزشکان مطب (با ذکر شفاف داده آزمایشی)
    doctors_seed = [
        (
            "dr-arman-farahmand",
            "دکتر آرمان فرهمند",
            "متخصص جراحی لثه و ایمپلنت دیجیتال",
            "کد نظام پزشکی نمونه: ۱۴۸۹۱۰ (داده آزمایشی)",
            "تمرکز حرفه‌ای بر کاشت ایمپلنت‌های هدایت‌شده دیجیتال، بازسازی بافت نرم و استخوان و درمان‌های کم‌تهاجمی با بهره‌گیری از اسکنرهای سه‌بعدی داخل‌دهانی.",
            "۱۲ سال تجربه بالینی نمونه • فلوشیپ ایمپلنت دیجیتال (نمایشی)",
            "emerald",
            json.dumps(
                {
                    "0": {"active": True, "start": "09:00", "end": "17:00"},
                    "1": {"active": False, "start": "09:00", "end": "17:00"},
                    "2": {"active": True, "start": "09:00", "end": "17:00"},
                    "3": {"active": False, "start": "09:00", "end": "17:00"},
                    "4": {"active": True, "start": "09:00", "end": "17:00"},
                    "5": {"active": True, "start": "09:00", "end": "14:00"},
                    "6": {"active": False, "start": "00:00", "end": "00:00"},
                },
                ensure_ascii=False,
            ),
            1,
        ),
        (
            "dr-niloofar-rastegar",
            "دکتر نیلوفر رستگار",
            "متخصص دندان‌پزشکی ترمیمی و طراحی لبخند",
            "کد نظام پزشکی نمونه: ۱۵۶۳۲۰ (داده آزمایشی)",
            "رویکرد محافظه‌کارانه (Biomimetic) در بازسازی تاج دندان، لمینت‌های سرامیکی فوق‌ظریف و اصلاح طرح لبخند با حفظ حداکثری بافت طبیعی مینای دندان.",
            "۹ سال تجربه بالینی نمونه • طراحی لبخند سه‌بعدی (نمایشی)",
            "teal",
            json.dumps(
                {
                    "0": {"active": True, "start": "10:00", "end": "18:30"},
                    "1": {"active": True, "start": "10:00", "end": "18:30"},
                    "2": {"active": False, "start": "10:00", "end": "18:30"},
                    "3": {"active": True, "start": "10:00", "end": "18:30"},
                    "4": {"active": True, "start": "10:00", "end": "18:30"},
                    "5": {"active": False, "start": "10:00", "end": "14:00"},
                    "6": {"active": False, "start": "00:00", "end": "00:00"},
                },
                ensure_ascii=False,
            ),
            1,
        ),
        (
            "dr-sohrab-kazemi",
            "دکتر سهراب کاظمی",
            "متخصص ارتودنسی و ناهنجاری‌های فک و صورت",
            "کد نظام پزشکی نمونه: ۱۶۲۴۰۵ (داده آزمایشی)",
            "طرح‌ریزی سه‌بعدی درمان‌های ارتودنسی شفاف (الاینر) و ارتودنسی ثابت برای بزرگسالان و نوجوانان با پایش دیجیتال روند حرکت دندان‌ها.",
            "۱۰ سال تجربه بالینی نمونه • ارتودنسی دیجیتال (نمایشی)",
            "coral",
            json.dumps(
                {
                    "0": {"active": False, "start": "11:00", "end": "19:00"},
                    "1": {"active": True, "start": "11:00", "end": "19:00"},
                    "2": {"active": True, "start": "11:00", "end": "19:00"},
                    "3": {"active": True, "start": "11:00", "end": "19:00"},
                    "4": {"active": False, "start": "11:00", "end": "19:00"},
                    "5": {"active": True, "start": "09:30", "end": "14:30"},
                    "6": {"active": False, "start": "00:00", "end": "00:00"},
                },
                ensure_ascii=False,
            ),
            1,
        ),
        (
            "dr-mahsa-javid",
            "دکتر مهسا جاوید",
            "متخصص درمان ریشه (اندودنتیکس) و دندان‌پزشکی کودکان",
            "کد نظام پزشکی نمونه: ۱۷۱۹۸۰ (داده آزمایشی)",
            "درمان‌های دقیق میکروسکوپی ریشه و ایجاد تجربه‌ای آرام، شاداب و بدون اضطراب برای کودکان و مراجعان حساس.",
            "۸ سال تجربه بالینی نمونه • اندودنتیکس میکروسکوپی (نمایشی)",
            "slate",
            json.dumps(
                {
                    "0": {"active": True, "start": "09:30", "end": "16:30"},
                    "1": {"active": True, "start": "09:30", "end": "16:30"},
                    "2": {"active": True, "start": "09:30", "end": "16:30"},
                    "3": {"active": False, "start": "09:30", "end": "16:30"},
                    "4": {"active": True, "start": "09:30", "end": "16:30"},
                    "5": {"active": False, "start": "09:30", "end": "14:00"},
                    "6": {"active": False, "start": "00:00", "end": "00:00"},
                },
                ensure_ascii=False,
            ),
            1,
        ),
    ]
    cursor.executemany(
        """
        INSERT INTO doctors (
            slug, name, specialty, medical_code, bio, experience_note,
            avatar_theme, schedule_json, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        doctors_seed,
    )

    # ۴. تنظیمات کامل مطب
    holiday_sample = offset_jalali(4)
    blocked_day_sample = offset_jalali(1)
    settings_seed = {
        "clinic_info": {
            "name": "مطب دندان‌پزشکی آویدا",
            "tagline": "دقت دیجیتال، آرامش کلینیکال و احترام به زمان شما",
            "hero_badge": "نسل نوین دندان‌پزشکی دیجیتال و سه‌بعدی (نسخه نمایشی)",
            "hero_title": "تجربه‌ای آرام، شفاف و دقیق از مراقبت و زیبایی لبخند",
            "hero_subtitle": "در مطب دندان‌پزشکی آویدا، با ترکیب تصویربرداری سه‌بعدی، استریلیزاسیون چندمرحله‌ای و نوبت‌دهی هوشمند بدون معطلی، سلامت دهان و دندان شما را با آرامش و دقت دنبال می‌کنیم.",
            "about_text": "مطب دندان‌پزشکی آویدا با هدف ایجاد محیطی به‌دور از اضطراب‌های مرسوم دندان‌پزشکی طراحی شده است. ما به شفافیت کامل طرح درمان، رعایت فاصله زمانی استاندارد برای ضدعفونی یونیت‌ها میان هر دو مراجع و ارائه مشاوره صادقانه پیش از هر اقدام درمانی باور داریم. (تمامی اطلاعات، پزشکان و تعرفه‌های این سامانه نمونه آزمایشی جهت نمایش امکانات نرم‌افزار هستند.)",
            "phone_primary": "۰۲۱-۸۸۹۹۴۴۱۱",
            "phone_support": "۰۹۱۲-۰۰۰-۰۰۰۱",
            "email": "info@avidadental.ir",
            "address": "تهران، خیابان ولیعصر، بالاتر از پارک ساعی، خیابان آویدا، پلاک ۲۴، طبقه سوم (نشانی نمونه آزمایشی)",
            "working_hours_text": "شنبه تا چهارشنبه: ۰۹:۰۰ الی ۲۰:۰۰ | پنجشنبه‌ها: ۰۹:۰۰ الی ۱۴:۳۰ | جمعه‌ها و تعطیلات رسمی: تعطیل",
            "response_time_label": "میانگین زمان پاسخگویی در ساعات کاری مطب: کمتر از ۲ ساعت",
            "staff_availability_status": "پاسخگویی بر اساس نوبت ثبت‌شده در ساعات کاری مطب (۰۹:۰۰ الی ۲۰:۰۰) — وضعیت حضور زنده بدون داده واقعی اعلام نمی‌شود",
            "medical_disclaimer": "توجه مهم: گفت‌وگوهای مشاوره آنلاین صرفاً جهت راهنمایی اولیه و آشنایی با روند خدمات بوده و جایگزین معاینه حضوری، تشخیص قطعی پزشکی یا تجویز دارو نیست.",
        },
        "scheduling_rules": {
            "buffer_minutes": 15,
            "slot_step_minutes": 30,
            "min_hours_before_cancel": 12,
            "min_hours_before_reschedule": 6,
            "max_reschedules": 2,
            "policy_text": "امکان لغو نوبت تا ۱۲ ساعت پیش از زمان ویزیت و امکان جابه‌جایی نوبت تا ۶ ساعت پیش از ویزیت (حداکثر ۲ بار برای هر نوبت) از طریق داشبورد مراجع فراهم است.",
        },
        "holidays": [
            {
                "jalali_date": holiday_sample,
                "reason": "تعطیلی برنامه‌ریزی‌شده مطب (سرویس دوره‌ای تجهیزات استریلیزاسیون)",
            }
        ],
        "blocked_slots": [
            {
                "id": "blk-1",
                "jalali_date": today_j,
                "doctor_id": 1,
                "start_time": "13:00",
                "end_time": "14:30",
                "reason": "استراحت ظهر و ضدعفونی عمیق یونیت",
            },
            {
                "id": "blk-2",
                "jalali_date": blocked_day_sample,
                "doctor_id": 2,
                "start_time": "14:00",
                "end_time": "15:30",
                "reason": "جلسه شورای تخصصی طراحی لبخند",
            },
        ],
    }

    for k, v in settings_seed.items():
        cursor.execute(
            "INSERT INTO clinic_settings (key, value_json) VALUES (?, ?)",
            (k, json.dumps(v, ensure_ascii=False)),
        )

    # ۵. نوبت‌های نمونه (گذشته و آینده برای مراجع نمونه)
    next_open_day = offset_jalali(2)
    # اگر روز جمعه افتاد یک روز جلوتر ببریم
    if jalali_weekday_index(next_open_day) == 6:
        next_open_day = offset_jalali(3)

    past_day = offset_jalali(-10)
    today_appt_day = today_j if jalali_weekday_index(today_j) != 6 else offset_jalali(1)

    appts_seed = [
        (
            "AVD-1405-10482",
            3,
            "سارا مرادی",
            "09121112233",
            2,
            2,
            next_open_day,
            "11:00",
            "12:00",
            60,
            15,
            "confirmed",
            "جلسه اسکن سه‌بعدی و بررسی اولیه طرح لبخند",
            0,
            now_iso,
            now_iso,
        ),
        (
            "AVD-1405-10119",
            3,
            "سارا مرادی",
            "09121112233",
            5,
            2,
            past_day,
            "16:00",
            "16:45",
            45,
            15,
            "completed",
            "جلسه برساژ و مشاوره اولیه بلیچینگ انجام شد.",
            0,
            now_iso,
            now_iso,
        ),
        (
            "AVD-1405-10501",
            2,
            "امیرحسین راد (نوبت نمونه)",
            "09123334455",
            1,
            1,
            today_appt_day,
            "10:00",
            "11:00",
            60,
            15,
            "confirmed",
            "ارزیابی اسکن CBCT ایمپلنت",
            0,
            now_iso,
            now_iso,
        ),
    ]
    cursor.executemany(
        """
        INSERT INTO appointments (
            tracking_code, user_id, patient_name, patient_phone, service_id, doctor_id,
            jalali_date, start_time, end_time, duration_min, buffer_min, status,
            notes, reschedule_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        appts_seed,
    )

    # ۶. مشاوره آنلاین نمونه
    cursor.execute(
        """
        INSERT INTO consultations (
            tracking_code, user_id, patient_name, patient_phone, service_id, doctor_id,
            subject, urgency, status, unread_by_patient, unread_by_staff, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "CNS-1405-3091",
            3,
            "سارا مرادی",
            "09121112233",
            2,
            2,
            "سؤال درباره میزان تراش دندان در لمینت سرامیکی",
            "عادی",
            "answered",
            1,
            0,
            now_iso,
            now_iso,
        ),
    )
    c_id_1 = cursor.lastrowid
    cursor.executemany(
        """
        INSERT INTO consultation_messages (
            consultation_id, sender_id, sender_name, sender_role, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                c_id_1,
                3,
                "سارا مرادی",
                "patient",
                "سلام وقت بخیر. برای اصلاح فاصله جزئی بین دو دندان جلویی فک بالا، آیا لمینت سرامیکی نیاز به تراش زیاد مینای دندان دارد؟",
                now_iso,
            ),
            (
                c_id_1,
                2,
                "دکتر نیلوفر رستگار (پاسخ نمونه)",
                "doctor",
                "سلام سرکار خانم مرادی عزیز. در موارد بستن فاصله‌های جزئی (دیاستم)، اغلب می‌توان از لمینت‌های بسیار ظریف کم‌تراش یا بدون تراش (پریپ‌لس) یا کامپوزیت ونیر محافظه‌کارانه استفاده کرد. تشخیص دقیق نوع روش پس از بررسی اکلوژن (نحوه قرارگیری دندان‌ها روی هم) در جلسه حضوری انجام می‌شود.",
                now_iso,
            ),
        ],
    )

    cursor.execute(
        """
        INSERT INTO consultations (
            tracking_code, user_id, patient_name, patient_phone, service_id, doctor_id,
            subject, urgency, status, unread_by_patient, unread_by_staff, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "CNS-1405-3098",
            3,
            "سارا مرادی",
            "09121112233",
            3,
            3,
            "مدت زمان تقریبی ارتودنسی شفاف برای فک پایین",
            "عادی",
            "pending",
            0,
            1,
            now_iso,
            now_iso,
        ),
    )
    c_id_2 = cursor.lastrowid
    cursor.execute(
        """
        INSERT INTO consultation_messages (
            consultation_id, sender_id, sender_name, sender_role, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            c_id_2,
            3,
            "سارا مرادی",
            "patient",
            "سلام، می‌خواستم بدانم در ارتودنسی با الاینر شفاف، هر چند هفته یک‌بار نیاز به مراجعه حضوری به مطب است؟",
            now_iso,
        ),
    )

    # ۷. تیکت پشتیبانی نمونه
    cursor.execute(
        """
        INSERT INTO support_tickets (
            tracking_code, user_id, name, contact, subject, category,
            status, unread_by_patient, unread_by_staff, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "SUP-1405-7741",
            3,
            "سارا مرادی",
            "09121112233",
            "درخواست صدور گواهی حضور و فاکتور جهت ارائه به بیمه تکمیلی",
            "مالی و بیمه",
            "answered",
            1,
            0,
            now_iso,
            now_iso,
        ),
    )
    t_id_1 = cursor.lastrowid
    cursor.executemany(
        """
        INSERT INTO support_messages (
            ticket_id, sender_id, sender_name, sender_role, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                t_id_1,
                3,
                "سارا مرادی",
                "patient",
                "سلام، لطفاً راهنمایی بفرمایید برای دریافت فاکتور ممهور جلسه گذشته جهت بیمه تکمیلی چطور اقدام کنم؟",
                now_iso,
            ),
            (
                t_id_1,
                1,
                "پشتیبانی مطب آویدا",
                "admin",
                "با سلام و احترام؛ پرونده مالی و گواهی حضور شما آماده است. در مراجعه بعدی خود می‌توانید نسخه چاپی ممهور را از پذیرش دریافت فرمایید.",
                now_iso,
            ),
        ],
    )

    # ۸. اعلان‌های نمونه برای مراجع
    cursor.executemany(
        """
        INSERT INTO notifications (user_id, title, body, type, link_route, is_read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                3,
                "پاسخ جدید در مشاوره آنلاین",
                "پاسخ پرسش شما درباره «لمینت سرامیکی» در بخش مشاوره آنلاین ثبت شد.",
                "consultation",
                "/dashboard",
                0,
                now_iso,
            ),
            (
                3,
                "پاسخ پشتیبانی درباره فاکتور بیمه",
                "واحد پذیرش و پشتیبانی مطب آویدا به درخواست شماره SUP-1405-7741 پاسخ داد.",
                "support",
                "/dashboard",
                0,
                now_iso,
            ),
            (
                3,
                "تأیید نوبت طراحی لبخند دیجیتال",
                f"نوبت شما با کد پیگیری AVD-1405-10482 برای تاریخ {format_jalali_human(next_open_day)} ساعت ۱۱:۰۰ ثبت و تأیید شده است.",
                "appointment",
                "/dashboard",
                1,
                now_iso,
            ),
        ],
    )

    # ۹. پرسش‌های متداول
    faqs_seed = [
        (
            "چگونه می‌توانم در مطب دندان‌پزشکی آویدا نوبت رزرو کنم؟",
            "از طریق بخش «رزرو نوبت» در بالای سایت، ابتدا خدمت مورد نظر و سپس پزشک را انتخاب کنید. در تقویم شمسی، روز و ساعت آزاد را برگزیده و پس از تأیید اطلاعات، کد پیگیری نوبت خود را در لحظه دریافت نمایید.",
            "نوبت‌دهی",
            1,
        ),
        (
            "قوانین لغو یا جابه‌جایی نوبت به چه صورت است؟",
            "شما می‌توانید از طریق «داشبورد مراجع» تا ۱۲ ساعت پیش از زمان نوبت نسبت به لغو و تا ۶ ساعت پیش از نوبت (حداکثر ۲ بار) نسبت به جابه‌جایی ساعت یا روز اقدام کنید تا زمان خالی برای سایر مراجعان آزاد شود.",
            "نوبت‌دهی",
            2,
        ),
        (
            "چرا بین نوبت‌ها فاصله زمانی در نظر گرفته شده است؟",
            "برای رعایت کامل اصول کنترل عفونت، بین هر دو نوبت یک بازه ۱۵ دقیقه‌ای (قابل تنظیم توسط مدیریت) جهت جمع‌آوری، ضدعفونی سطوح یونیت و تهویه هوای اتاق درمان در سامانه لحاظ می‌شود.",
            "بهداشت و ایمنی",
            3,
        ),
        (
            "آیا مشاوره آنلاین جایگزین معاینه حضوری است؟",
            "خیر؛ مشاوره آنلاین متنی برای پاسخ به پرسش‌های اولیه، آشنایی با مراحل خدمات و برآورد حدود جلسات طراحی شده است. تشخیص قطعی و طرح درمان نهایی منوط به معاینه بالینی و بررسی تصاویر رادیوگرافی در مطب است.",
            "مشاوره آنلاین",
            4,
        ),
        (
            "آیا هزینه‌های نمایش‌داده‌شده در سایت قطعی هستند؟",
            "هزینه‌های درج‌شده در صفحه خدمات به‌عنوان نمونه و حدود قیمت آزمایشی ارائه شده‌اند. هزینه دقیق پس از معاینه حضوری و مشخص شدن جزئیات درمانی به اطلاع شما می‌رسد.",
            "مالی و بیمه",
            5,
        ),
    ]
    cursor.executemany(
        "INSERT INTO faqs (question, answer, category, sort_order) VALUES (?, ?, ?, ?)",
        faqs_seed,
    )


# ---------------------------------------------------------------------------
# توابع کمکی منطق کسب‌وکار (ظرفیت نوبت، جلوگیری از تداخل و قوانین مطب)
# ---------------------------------------------------------------------------
def get_all_settings(conn) -> dict:
    rows = conn.execute("SELECT key, value_json FROM clinic_settings").fetchall()
    result = {}
    for r in rows:
        try:
            result[r["key"]] = json.loads(r["value_json"])
        except Exception:
            result[r["key"]] = {}
    return result


def validate_schedule(schedule):
    if not isinstance(schedule, dict) or any(str(key) not in "0123456" or len(str(key)) != 1 for key in schedule):
        raise ValueError("ساختار برنامه حضور پزشک نامعتبر است.")
    for day in schedule.values():
        if not isinstance(day, dict) or not isinstance(day.get("active", False), bool):
            raise ValueError("ساختار روزهای حضور پزشک نامعتبر است.")
        if day.get("active") and time_to_minutes(day.get("start", "")) >= time_to_minutes(day.get("end", "")):
            raise ValueError("پایان شیفت باید پس از شروع شیفت باشد.")


def validate_settings_value(key, value, conn):
    if key in ("clinic_info", "scheduling_rules"):
        if not isinstance(value, dict):
            raise ValueError("تنظیمات باید به شکل شیء JSON باشد.")
        if key == "clinic_info" and any(not isinstance(v, str) for v in value.values()):
            raise ValueError("اطلاعات عمومی مطب باید متن باشد.")
        if key == "scheduling_rules":
            bounds = {"buffer_minutes": (0, 1440), "slot_step_minutes": (1, 1440),
                      "min_hours_before_cancel": (0, 8760), "min_hours_before_reschedule": (0, 8760),
                      "max_reschedules": (0, 100)}
            for field, (low, high) in bounds.items():
                if field in value and (type(value[field]) is not int or not low <= value[field] <= high):
                    raise ValueError("مقادیر قوانین زمان‌بندی خارج از محدوده مجاز است.")
        return
    if not isinstance(value, list):
        raise ValueError("تعطیلی‌ها و مسدودی‌ها باید فهرست باشند.")
    for entry in value:
        if not isinstance(entry, dict):
            raise ValueError("ساختار تاریخ‌های تنظیمات نامعتبر است.")
        entry["jalali_date"] = parse_jalali_date(entry.get("jalali_date", ""))[3]
        if key == "blocked_slots":
            if time_to_minutes(entry.get("start_time", "")) >= time_to_minutes(entry.get("end_time", "")):
                raise ValueError("پایان بازه مسدود باید پس از شروع آن باشد.")
            doctor_id = entry.get("doctor_id")
            if doctor_id not in (None, "", 0) and not conn.execute("SELECT id FROM doctors WHERE id = ?", (doctor_id,)).fetchone():
                raise ValueError("پزشک بازه مسدود یافت نشد.")


def appointment_slot_available(conn, appointment):
    day = compute_day_slots(conn, appointment["service_id"], appointment["doctor_id"],
                            appointment["jalali_date"], exclude_appointment_id=appointment["id"],
                            duration_override=appointment["duration_min"], buffer_override=appointment["buffer_min"])
    return any(slot["start_time"] == appointment["start_time"] and slot["status"] == "available"
               for slot in day["slots"])


def compute_day_slots(conn, service_id: int, doctor_id: int, jalali_date: str,
                      exclude_appointment_id=None, duration_override=None, buffer_override=None) -> dict:
    """
    محاسبه دقیق بازه‌های زمانی یک روز مشخص با در نظر گرفتن:
    - مدت زمان خدمت (duration_min)
    - فاصله ضدعفونی بین نوبت‌ها (buffer_minutes)
    - برنامه حضور هفتگی پزشک
    - تعطیلات مطب
    - بازه‌های مسدودشده
    - نوبت‌های فعال ثبت‌شده در پایگاه داده
    """
    _, _, _, norm_date = parse_jalali_date(jalali_date)
    w_idx = jalali_weekday_index(norm_date)

    service = conn.execute(
        "SELECT * FROM services WHERE id = ? AND active = 1", (service_id,)
    ).fetchone()
    if not service:
        raise ValueError("خدمت انتخاب‌شده یافت نشد یا غیرفعال است.")

    doctor = conn.execute(
        "SELECT * FROM doctors WHERE id = ? AND active = 1", (doctor_id,)
    ).fetchone()
    if not doctor:
        raise ValueError("پزشک انتخاب‌شده یافت نشد یا غیرفعال است.")

    settings = get_all_settings(conn)
    rules = settings.get("scheduling_rules", {})
    buffer_min = int(rules.get("buffer_minutes", 15) if buffer_override is None else buffer_override)
    step_min = int(rules.get("slot_step_minutes", 30))
    duration_min = int(service["duration_min"] if duration_override is None else duration_override)
    if not (1 <= step_min <= 1440 and 1 <= duration_min <= 1440 and 0 <= buffer_min <= 1440):
        raise ValueError("مدت خدمت، فاصله نوبت‌ها یا گام تقویم نامعتبر است.")

    holidays = settings.get("holidays", [])
    for h in holidays:
        if to_en_digits(h.get("jalali_date", "")) == norm_date:
            return {
                "jalali_date": norm_date,
                "human_date": format_jalali_human(norm_date),
                "weekday": WEEKDAY_NAMES_FA[w_idx],
                "is_holiday": True,
                "holiday_reason": h.get("reason", "تعطیل رسمی / مطب"),
                "doctor_working": False,
                "duration_min": duration_min,
                "buffer_min": buffer_min,
                "slots": [],
            }

    schedule = json.loads(doctor["schedule_json"])
    day_sched = schedule.get(str(w_idx), {"active": False})
    if not day_sched.get("active", False):
        return {
            "jalali_date": norm_date,
            "human_date": format_jalali_human(norm_date),
            "weekday": WEEKDAY_NAMES_FA[w_idx],
            "is_holiday": False,
            "holiday_reason": "",
            "doctor_working": False,
            "duration_min": duration_min,
            "buffer_min": buffer_min,
            "slots": [],
        }

    shift_start = time_to_minutes(day_sched.get("start", "09:00"))
    shift_end = time_to_minutes(day_sched.get("end", "17:00"))

    # بازه‌های مسدودشده
    blocked_list = []
    for b in settings.get("blocked_slots", []):
        if to_en_digits(b.get("jalali_date", "")) == norm_date:
            b_doc = b.get("doctor_id")
            if b_doc in (None, "", 0, doctor_id, str(doctor_id)):
                blocked_list.append(
                    {
                        "start": time_to_minutes(b["start_time"]),
                        "end": time_to_minutes(b["end_time"]),
                        "reason": b.get("reason", "مسدودشده توسط مطب"),
                    }
                )

    # نوبت‌های رزروشده فعال برای این پزشک در این تاریخ
    booked_rows = conn.execute(
        """
        SELECT id, start_time, end_time, duration_min, buffer_min
        FROM appointments
        WHERE doctor_id = ? AND jalali_date = ? AND status IN ('confirmed', 'pending', 'rescheduled')
        """,
        (doctor_id, norm_date),
    ).fetchall()

    booked_intervals = []
    for r in booked_rows:
        if r["id"] == exclude_appointment_id:
            continue
        b_start = time_to_minutes(r["start_time"])
        b_end = time_to_minutes(r["end_time"]) + int(r["buffer_min"])
        booked_intervals.append({"id": r["id"], "start": b_start, "end": b_end})

    slots = []
    cur = shift_start
    now = iran_now()
    while cur + duration_min <= shift_end:
        slot_start = cur
        slot_service_end = cur + duration_min
        slot_Buffered_end = slot_service_end + buffer_min

        status = "available"
        reason = "آزاد و قابل رزرو"

        # ۱. بررسی تداخل با بازه‌های مسدودشده
        for blk in blocked_list:
            if slot_start < blk["end"] and slot_Buffered_end > blk["start"]:
                status = "blocked"
                reason = blk["reason"]
                break

        # ۲. بررسی تداخل با نوبت‌های رزروشده (با احتساب فاصله ضدعفونی)
        if status == "available":
            for bkd in booked_intervals:
                if slot_start < bkd["end"] and slot_Buffered_end > bkd["start"]:
                    status = "booked"
                    reason = "رزروشده"
                    break

        if jalali_datetime_from_str(norm_date, minutes_to_time(slot_start)) <= now:
            status = "past"
            reason = "زمان این نوبت گذشته است."

        slots.append(
            {
                "start_time": minutes_to_time(slot_start),
                "end_time": minutes_to_time(slot_service_end),
                "start_time_fa": to_fa_digits(minutes_to_time(slot_start)),
                "end_time_fa": to_fa_digits(minutes_to_time(slot_service_end)),
                "duration_min": duration_min,
                "buffer_min": buffer_min,
                "status": status,
                "reason": reason,
            }
        )
        cur += step_min

    return {
        "jalali_date": norm_date,
        "human_date": format_jalali_human(norm_date),
        "weekday": WEEKDAY_NAMES_FA[w_idx],
        "is_holiday": False,
        "holiday_reason": "",
        "doctor_working": True,
        "shift_start": day_sched.get("start", "09:00"),
        "shift_end": day_sched.get("end", "17:00"),
        "duration_min": duration_min,
        "buffer_min": buffer_min,
        "slots": slots,
    }


def find_alternative_slots(
    conn, service_id: int, doctor_id: int, from_jalali_date: str, limit: int = 4
) -> list:
    """پیدا کردن نزدیک‌ترین ساعت‌های آزاد جایگزین در همان روز یا روزهای کاری بعدی"""
    jy, jm, jd, _ = parse_jalali_date(from_jalali_date)
    gy, gm, gd = jalali_to_gregorian(jy, jm, jd)
    base_d = datetime.date(gy, gm, gd)
    alternatives = []

    for day_offset in range(0, 10):
        target_d = base_d + datetime.timedelta(days=day_offset)
        ty, tm, td = gregorian_to_jalali(target_d.year, target_d.month, target_d.day)
        j_str = f"{ty:04d}/{tm:02d}/{td:02d}"
        day_info = compute_day_slots(conn, service_id, doctor_id, j_str)
        for s in day_info.get("slots", []):
            if s["status"] == "available":
                alternatives.append(
                    {
                        "jalali_date": j_str,
                        "human_date": day_info["human_date"],
                        "start_time": s["start_time"],
                        "end_time": s["end_time"],
                        "start_time_fa": s["start_time_fa"],
                        "end_time_fa": s["end_time_fa"],
                    }
                )
                if len(alternatives) >= limit:
                    return alternatives
    return alternatives


# ---------------------------------------------------------------------------
# تولید صفحات سئو، نقشه سایت و داده‌های ساختاریافته
# ---------------------------------------------------------------------------
ROUTE_SEO_META = {
    "/": {
        "title": "مطب دندان‌پزشکی آویدا | دندان‌پزشکی دیجیتال، طراحی لبخند سه‌بعدی و نوبت‌دهی آنلاین",
        "description": "مطب دندان‌پزشکی آویدا؛ ارائه‌دهنده خدمات ایمپلنت دیجیتال، طراحی لبخند سه‌بعدی، ارتودنسی شفاف و درمان ریشه با نوبت‌دهی آنلاین شمسی و مشاوره تخصصی.",
        "robots": "index, follow",
    },
    "/services": {
        "title": "خدمات دندان‌پزشکی و تعرفه‌های نمونه | مطب دندان‌پزشکی آویدا",
        "description": "آشنایی با خدمات ایمپلنت دیجیتال، لمینت سرامیکی، ارتودنسی شفاف، درمان ریشه میکروسکوپی و بلیچینگ همراه با مدت جلسه و هزینه‌های نمونه در مطب آویدا.",
        "robots": "index, follow",
    },
    "/doctors": {
        "title": "معرفی دندان‌پزشکان متخصص و برنامه حضور | مطب دندان‌پزشکی آویدا",
        "description": "آشنایی با تیم دندان‌پزشکان متخصص مطب آویدا، برنامه حضور هفتگی، استانداردهای استریلیزاسیون و تجهیزات دیجیتال سه‌بعدی.",
        "robots": "index, follow",
    },
    "/booking": {
        "title": "رزرو آنلاین نوبت دندان‌پزشکی (تقویم شمسی) | مطب دندان‌پزشکی آویدا",
        "description": "رزرو مرحله‌به‌مرحله نوبت دندان‌پزشکی در مطب آویدا با انتخاب خدمت، پزشک، روز و ساعت آزاد در تقویم شمسی و دریافت کد پیگیری آنی.",
        "robots": "index, follow",
    },
    "/consultation": {
        "title": "مشاوره آنلاین دندان‌پزشکی و پرسش از پزشک | مطب دندان‌پزشکی آویدا",
        "description": "ثبت درخواست مشاوره متنی با دندان‌پزشکان و کارشناسان مطب آویدا برای بررسی اولیه طرح درمان و پاسخ به پرسش‌های درمانی.",
        "robots": "index, follow",
    },
    "/contact": {
        "title": "تماس با مطب و پشتیبانی مراجعان | مطب دندان‌پزشکی آویدا",
        "description": "اطلاعات تماس، ساعات کاری، نشانی مطب دندان‌پزشکی آویدا و سامانه ثبت و پیگیری درخواست‌های پشتیبانی مراجعان.",
        "robots": "index, follow",
    },
    "/auth": {
        "title": "ورود، ثبت‌نام و بازیابی حساب کاربری | مطب دندان‌پزشکی آویدا",
        "description": "ورود به حساب کاربری مراجعان و پرسنل مطب دندان‌پزشکی آویدا.",
        "robots": "noindex, nofollow",
    },
    "/dashboard": {
        "title": "داشبورد اختصاصی مراجع | مطب دندان‌پزشکی آویدا",
        "description": "مدیریت نوبت‌ها، مشاهده گفت‌وگوهای مشاوره آنلاین و پیام‌های پشتیبانی در حساب کاربری مراجع.",
        "robots": "noindex, nofollow",
    },
    "/admin": {
        "title": "پنل مدیریت صاحب مطب | مطب دندان‌پزشکی آویدا",
        "description": "پنل مدیریت اختصاصی خدمات، پزشکان، نوبت‌ها، مشاوره‌ها و تنظیمات مطب دندان‌پزشکی آویدا.",
        "robots": "noindex, nofollow",
    },
}


# ---------------------------------------------------------------------------
# کنترلر درخواست‌های HTTP و REST API
# ---------------------------------------------------------------------------
class AvidaRequestHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # ثبت تمیز لاگ‌ها
        sys.stderr.write(f"[AvidaServer] {self.address_string()} - {fmt % args}\n")

    def send_json(self, status_code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_text(
        self,
        status_code: int,
        text: str,
        content_type: str = "text/plain; charset=utf-8",
        extra_headers: dict = None,
    ):
        body = text.encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length > 1024 * 1024:
            self.close_connection = True
            raise ValueError("درخواست بیش از حد بزرگ است.")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        data = json.loads(raw) if raw else {}
        if not isinstance(data, dict):
            raise ValueError("بدنه درخواست باید یک شیء JSON باشد.")
        return data

    def get_current_user(self, conn):
        auth_header = self.headers.get("Authorization", "")
        token = ""
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        if not token:
            return None
        row = conn.execute(
            """
            SELECT u.id, u.name, u.phone, u.email, u.role, s.expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (token,),
        ).fetchone()
        if not row:
            return None
        try:
            if datetime.datetime.fromisoformat(row["expires_at"]) <= iran_now():
                return None
        except (TypeError, ValueError):
            return None
        return dict(row)

    # -----------------------------------------------------------------------
    # مسیرهای GET
    # -----------------------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # ۱. robots.txt
        if path == "/robots.txt":
            robots_txt = (
                "User-agent: *\n"
                "Allow: /\n"
                "Allow: /services\n"
                "Allow: /doctors\n"
                "Allow: /booking\n"
                "Allow: /consultation\n"
                "Allow: /contact\n"
                "Disallow: /auth\n"
                "Disallow: /dashboard\n"
                "Disallow: /admin\n"
                "Disallow: /api/\n"
                "Sitemap: http://localhost:8080/sitemap.xml\n"
            )
            return self.send_text(200, robots_txt, "text/plain; charset=utf-8")

        # ۲. sitemap.xml
        if path == "/sitemap.xml":
            conn = get_db_connection()
            services = conn.execute(
                "SELECT slug FROM services WHERE active = 1"
            ).fetchall()
            conn.close()
            urls = [
                "http://localhost:8080/",
                "http://localhost:8080/services",
                "http://localhost:8080/doctors",
                "http://localhost:8080/booking",
                "http://localhost:8080/consultation",
                "http://localhost:8080/contact",
            ]
            for s in services:
                urls.append(f"http://localhost:8080/services/{s['slug']}")
            xml_items = "\n".join(
                f"  <url><loc>{u}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>"
                for u in urls
            )
            sitemap_xml = (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                f"{xml_items}\n"
                "</urlset>"
            )
            return self.send_text(200, sitemap_xml, "application/xml; charset=utf-8")

        # ۳. فایل‌های استاتیک (/static/...)
        if path.startswith("/static/"):
            rel_path = urllib.parse.unquote(path[len("/static/") :])
            safe_path = (STATIC_DIR / rel_path).resolve()
            if not safe_path.is_relative_to(STATIC_DIR.resolve()) or not safe_path.is_file():
                return self.send_json(404, {"error": "فایل مورد نظر یافت نشد."})
            ext = safe_path.suffix.lower()
            mime_map = {
                ".css": "text/css; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".ttf": "font/ttf",
                ".woff2": "font/woff2",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".json": "application/json; charset=utf-8",
            }
            ctype = mime_map.get(ext, "application/octet-stream")
            data = safe_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache" if ext in (".css", ".js", ".html") else "public, max-age=86400")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)
            return

        # ۴. مسیرهای API
        if path.startswith("/api/"):
            return self.handle_api_get(path, query)

        # ۵. صفحات برنامه (SPA + SSR SEO Meta Injection)
        return self.serve_spa_html(path)

    def serve_spa_html(self, path: str):
        index_file = STATIC_DIR / "index.html"
        if not index_file.is_file():
            return self.send_text(500, "فایل قالب رابط کاربری هنوز ساخته نشده است.")
        html = index_file.read_text("utf-8")

        # تعیین متادیتای اختصاصی هر مسیر
        norm_path = ("/" if path in ("/", "/index.html") else path[:-5] if path.endswith(".html") else path)
        meta = ROUTE_SEO_META.get(norm_path)
        conn = get_db_connection()
        if not meta and norm_path.startswith("/services/"):
            slug = norm_path.split("/services/", 1)[1].strip("/")
            srv = conn.execute(
                "SELECT title, short_desc FROM services WHERE slug = ?", (slug,)
            ).fetchone()
            if srv:
                meta = {
                    "title": f"{srv['title']} | مطب دندان‌پزشکی آویدا",
                    "description": srv["short_desc"],
                    "robots": "index, follow",
                }
        conn.close()

        if not meta:
            return self.send_text(404, "صفحه مورد نظر یافت نشد.")

        canonical_url = f"http://localhost:8080{norm_path}"
        html = html.replace("__SEO_TITLE__", html_lib.escape(meta["title"]))
        html = html.replace("__SEO_DESCRIPTION__", html_lib.escape(meta["description"], quote=True))
        html = html.replace("__SEO_ROBOTS__", meta["robots"])
        html = html.replace("__SEO_CANONICAL__", canonical_url)

        extra_headers = {"X-Robots-Tag": meta["robots"], "Cache-Control": "no-cache"}
        return self.send_text(200, html, "text/html; charset=utf-8", extra_headers)

    def handle_api_get(self, path: str, query: dict):
        conn = get_db_connection()
        try:
            if path == "/api/bootstrap":
                settings = get_all_settings(conn)
                services = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM services WHERE active = 1 ORDER BY id ASC"
                    ).fetchall()
                ]
                doctors = []
                for r in conn.execute(
                    "SELECT * FROM doctors WHERE active = 1 ORDER BY id ASC"
                ).fetchall():
                    d = dict(r)
                    d["schedule"] = json.loads(d["schedule_json"])
                    doctors.append(d)
                faqs = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM faqs ORDER BY sort_order ASC, id ASC"
                    ).fetchall()
                ]
                user = self.get_current_user(conn)

                # تولید فهرست ۱۴ روز آینده به شمسی برای تقویم
                today_j = today_jalali_str()
                jy, jm, jd, _ = parse_jalali_date(today_j)
                gy, gm, gd = jalali_to_gregorian(jy, jm, jd)
                base_d = datetime.date(gy, gm, gd)
                upcoming_days = []
                holidays_map = {
                    to_en_digits(h.get("jalali_date", "")): h.get("reason", "تعطیل")
                    for h in settings.get("holidays", [])
                }
                for i in range(14):
                    td = base_d + datetime.timedelta(days=i)
                    ty, tm, tday = gregorian_to_jalali(td.year, td.month, td.day)
                    j_code = f"{ty:04d}/{tm:02d}/{tday:02d}"
                    w_idx = (td.weekday() + 2) % 7
                    upcoming_days.append(
                        {
                            "jalali_date": j_code,
                            "jalali_date_fa": to_fa_digits(j_code),
                            "day_num_fa": to_fa_digits(tday),
                            "month_name": JALALI_MONTH_NAMES[tm],
                            "weekday_idx": w_idx,
                            "weekday_name": WEEKDAY_NAMES_FA[w_idx],
                            "human": format_jalali_human(j_code),
                            "is_friday": w_idx == 6,
                            "is_holiday": (w_idx == 6) or (j_code in holidays_map),
                            "holiday_reason": "تعطیلی آخر هفته (جمعه)"
                            if w_idx == 6
                            else holidays_map.get(j_code, ""),
                        }
                    )

                return self.send_json(
                    200,
                    {
                        "today_jalali": today_j,
                        "today_human": format_jalali_human(today_j),
                        "settings": settings,
                        "services": services,
                        "doctors": doctors,
                        "faqs": faqs,
                        "upcoming_days": upcoming_days,
                        "user": user,
                    },
                )

            if path == "/api/slots":
                service_id = int(query.get("service_id", [1])[0])
                doctor_id = int(query.get("doctor_id", [1])[0])
                jalali_date = query.get("jalali_date", [today_jalali_str()])[0]
                slot_options = {}
                if "appointment_id" in query:
                    user = self.get_current_user(conn)
                    if not user:
                        return self.send_json(401, {"error": "برای جابه‌جایی نوبت وارد حساب کاربری شوید."})
                    appointment_id = int(query["appointment_id"][0])
                    appointment = conn.execute("SELECT * FROM appointments WHERE id = ?", (appointment_id,)).fetchone()
                    if not appointment:
                        return self.send_json(404, {"error": "نوبت مورد نظر یافت نشد."})
                    if appointment["user_id"] != user["id"] and user["role"] not in ("admin", "doctor"):
                        return self.send_json(403, {"error": "شما تنها مجاز به مدیریت نوبت‌های خودتان هستید."})
                    if appointment["service_id"] != service_id or appointment["doctor_id"] != doctor_id:
                        return self.send_json(400, {"error": "خدمت و پزشک باید با نوبت انتخاب‌شده مطابقت داشته باشند."})
                    slot_options = {"exclude_appointment_id": appointment_id,
                                    "duration_override": appointment["duration_min"],
                                    "buffer_override": appointment["buffer_min"]}
                slot_data = compute_day_slots(conn, service_id, doctor_id, jalali_date, **slot_options)
                return self.send_json(200, slot_data)

            if path == "/api/dashboard":
                user = self.get_current_user(conn)
                if not user:
                    return self.send_json(
                        401, {"error": "لطفاً ابتدا وارد حساب کاربری خود شوید."}
                    )

                appts = [
                    dict(r)
                    for r in conn.execute(
                        """
                        SELECT a.*, s.title AS service_title, s.price_sample, d.name AS doctor_name, d.specialty AS doctor_specialty
                        FROM appointments a
                        JOIN services s ON s.id = a.service_id
                        JOIN doctors d ON d.id = a.doctor_id
                        WHERE a.user_id = ?
                        ORDER BY a.jalali_date DESC, a.start_time DESC
                        """,
                        (user["id"],),
                    ).fetchall()
                ]
                for a in appts:
                    a["human_date"] = format_jalali_human(a["jalali_date"])

                consults = [
                    dict(r)
                    for r in conn.execute(
                        """
                        SELECT c.*, s.title AS service_title, d.name AS doctor_name
                        FROM consultations c
                        LEFT JOIN services s ON s.id = c.service_id
                        LEFT JOIN doctors d ON d.id = c.doctor_id
                        WHERE c.user_id = ?
                        ORDER BY c.updated_at DESC
                        """,
                        (user["id"],),
                    ).fetchall()
                ]
                for c in consults:
                    c["messages"] = [
                        dict(m)
                        for m in conn.execute(
                            "SELECT * FROM consultation_messages WHERE consultation_id = ? ORDER BY id ASC",
                            (c["id"],),
                        ).fetchall()
                    ]

                tickets = [
                    dict(r)
                    for r in conn.execute(
                        """
                        SELECT * FROM support_tickets
                        WHERE user_id = ?
                        ORDER BY updated_at DESC
                        """,
                        (user["id"],),
                    ).fetchall()
                ]
                for t in tickets:
                    t["messages"] = [
                        dict(m)
                        for m in conn.execute(
                            "SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC",
                            (t["id"],),
                        ).fetchall()
                    ]

                notifs = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20",
                        (user["id"],),
                    ).fetchall()
                ]

                return self.send_json(
                    200,
                    {
                        "user": user,
                        "appointments": appts,
                        "consultations": consults,
                        "support_tickets": tickets,
                        "notifications": notifs,
                    },
                )

            if path == "/api/admin/overview":
                user = self.get_current_user(conn)
                if not user or user["role"] not in ("admin", "doctor"):
                    return self.send_json(
                        403,
                        {
                            "error": "دسترسی غیرمجاز؛ این بخش ویژه مدیریت و پرسنل مجاز مطب است."
                        },
                    )

                appts = [
                    dict(r)
                    for r in conn.execute(
                        """
                        SELECT a.*, s.title AS service_title, d.name AS doctor_name
                        FROM appointments a
                        JOIN services s ON s.id = a.service_id
                        JOIN doctors d ON d.id = a.doctor_id
                        ORDER BY a.jalali_date DESC, a.start_time ASC
                        """
                    ).fetchall()
                ]
                for a in appts:
                    a["human_date"] = format_jalali_human(a["jalali_date"])

                consults = [
                    dict(r)
                    for r in conn.execute(
                        """
                        SELECT c.*, s.title AS service_title, d.name AS doctor_name
                        FROM consultations c
                        LEFT JOIN services s ON s.id = c.service_id
                        LEFT JOIN doctors d ON d.id = c.doctor_id
                        ORDER BY c.updated_at DESC
                        """
                    ).fetchall()
                ]
                for c in consults:
                    c["messages"] = [
                        dict(m)
                        for m in conn.execute(
                            "SELECT * FROM consultation_messages WHERE consultation_id = ? ORDER BY id ASC",
                            (c["id"],),
                        ).fetchall()
                    ]

                tickets = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM support_tickets ORDER BY updated_at DESC"
                    ).fetchall()
                ]
                for t in tickets:
                    t["messages"] = [
                        dict(m)
                        for m in conn.execute(
                            "SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC",
                            (t["id"],),
                        ).fetchall()
                    ]

                services = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM services ORDER BY id ASC"
                    ).fetchall()
                ]
                doctors = []
                for r in conn.execute("SELECT * FROM doctors ORDER BY id ASC").fetchall():
                    d = dict(r)
                    d["schedule"] = json.loads(d["schedule_json"])
                    doctors.append(d)

                faqs = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM faqs ORDER BY sort_order ASC, id ASC"
                    ).fetchall()
                ]
                trash = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM trash_bin ORDER BY id DESC LIMIT 15"
                    ).fetchall()
                ]
                settings = get_all_settings(conn)

                today_j = today_jalali_str()
                stats = {
                    "total_appointments": len(appts),
                    "active_appointments": sum(
                        1
                        for a in appts
                        if a["status"] in ("confirmed", "pending", "rescheduled")
                    ),
                    "today_appointments": sum(
                        1
                        for a in appts
                        if a["jalali_date"] == today_j
                        and a["status"] in ("confirmed", "pending", "rescheduled")
                    ),
                    "pending_consultations": sum(
                        1 for c in consults if c["status"] == "pending"
                    ),
                    "pending_tickets": sum(
                        1 for t in tickets if t["status"] == "pending"
                    ),
                    "total_patients": conn.execute(
                        "SELECT COUNT(*) AS cnt FROM users WHERE role = 'patient'"
                    ).fetchone()["cnt"],
                }

                return self.send_json(
                    200,
                    {
                        "stats": stats,
                        "appointments": appts,
                        "consultations": consults,
                        "support_tickets": tickets,
                        "services": services,
                        "doctors": doctors,
                        "faqs": faqs,
                        "trash": trash,
                        "settings": settings,
                    },
                )

            return self.send_json(404, {"error": "مسیر API یافت نشد."})
        except Exception as e:
            return self.send_json(400, {"error": str(e)})
        finally:
            conn.close()

    # -----------------------------------------------------------------------
    # مسیرهای POST
    # -----------------------------------------------------------------------
    def do_POST(self):
        try:
            return self.handle_post()
        except sqlite3.IntegrityError:
            return self.send_json(409, {"error": "این اطلاعات قبلاً ثبت شده یا با اطلاعات موجود تداخل دارد."})
        except (ValueError, TypeError, AttributeError, KeyError):
            return self.send_json(400, {"error": "مقادیر ارسالی نامعتبر است؛ اطلاعات فرم را بررسی کنید."})

    def handle_post(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self.read_json_body()
        except Exception:
            return self.send_json(400, {"error": "ساختار JSON ارسالی نامعتبر است."})

        # ۱. ثبت‌نام کاربر جدید
        if path == "/api/auth/register":
            name = (body.get("name") or "").strip()
            identifier = to_en_digits((body.get("identifier") or "").strip())
            password = body.get("password") or ""

            if len(name) < 3:
                return self.send_json(
                    400, {"error": "لطفاً نام و نام خانوادگی معتبر (حداقل ۳ حرف) وارد کنید."}
                )
            if len(password) < 6:
                return self.send_json(
                    400, {"error": "رمز عبور باید حداقل ۶ کاراکتر باشد."}
                )

            phone = None
            email = None
            if "@" in identifier:
                if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", identifier):
                    return self.send_json(400, {"error": "فرمت ایمیل واردشده صحیح نیست."})
                email = identifier.lower()
            else:
                clean_phone = re.sub(r"\D", "", identifier)
                if not re.match(r"^09\d{9}$", clean_phone):
                    return self.send_json(
                        400,
                        {
                            "error": "شماره همراه باید ۱۱ رقمی و با ۰۹ شروع شود (مانند ۰۹۱۲۱۱۱۲۲۳۳) یا ایمیل معتبر وارد نمایید."
                        },
                    )
                phone = clean_phone

            conn = get_db_connection()
            try:
                if phone and conn.execute(
                    "SELECT id FROM users WHERE phone = ?", (phone,)
                ).fetchone():
                    return self.send_json(
                        409, {"error": "این شماره همراه پیش‌تر ثبت‌نام شده است."}
                    )
                if email and conn.execute(
                    "SELECT id FROM users WHERE email = ?", (email,)
                ).fetchone():
                    return self.send_json(
                        409, {"error": "این نشانی ایمیل پیش‌تر ثبت‌نام شده است."}
                    )

                now_iso = iran_now().isoformat()
                pw_hash = hash_password(password)
                cur = conn.execute(
                    "INSERT INTO users (name, phone, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'patient', ?)",
                    (name, phone, email, pw_hash, now_iso),
                )
                user_id = cur.lastrowid
                token = secrets.token_urlsafe(32)
                expires = (iran_now() + datetime.timedelta(days=14)).isoformat()
                conn.execute(
                    "INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?, ?, 'patient', ?)",
                    (token, user_id, expires),
                )
                conn.execute(
                    "INSERT INTO notifications (user_id, title, body, type, link_route, is_read, created_at) VALUES (?, ?, ?, 'welcome', '/dashboard', 0, ?)",
                    (
                        user_id,
                        "خوش‌آمدید به مطب دندان‌پزشکی آویدا",
                        "حساب کاربری شما با موفقیت ایجاد شد. اکنون می‌توانید نوبت رزرو کنید یا درخواست مشاوره آنلاین ثبت نمایید.",
                        now_iso,
                    ),
                )
                conn.commit()
                return self.send_json(
                    201,
                    {
                        "message": "ثبت‌نام شما با موفقیت انجام شد.",
                        "token": token,
                        "user": {
                            "id": user_id,
                            "name": name,
                            "phone": phone,
                            "email": email,
                            "role": "patient",
                        },
                    },
                )
            finally:
                conn.close()

        # ۲. ورود به حساب کاربری
        if path == "/api/auth/login":
            identifier = to_en_digits((body.get("identifier") or "").strip())
            password = body.get("password") or ""
            if not identifier or not password:
                return self.send_json(
                    400, {"error": "لطفاً شماره همراه/ایمیل و رمز عبور را وارد کنید."}
                )

            conn = get_db_connection()
            try:
                user = conn.execute(
                    "SELECT * FROM users WHERE phone = ? OR LOWER(email) = LOWER(?)",
                    (identifier, identifier),
                ).fetchone()
                if not user or not verify_password(password, user["password_hash"]):
                    return self.send_json(
                        401, {"error": "شماره همراه/ایمیل یا رمز عبور اشتباه است."}
                    )

                token = secrets.token_urlsafe(32)
                expires = (iran_now() + datetime.timedelta(days=14)).isoformat()
                conn.execute(
                    "INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?, ?, ?, ?)",
                    (token, user["id"], user["role"], expires),
                )
                conn.commit()
                return self.send_json(
                    200,
                    {
                        "message": f"خوش آمدید، {user['name']}",
                        "token": token,
                        "user": {
                            "id": user["id"],
                            "name": user["name"],
                            "phone": user["phone"],
                            "email": user["email"],
                            "role": user["role"],
                        },
                    },
                )
            finally:
                conn.close()

        # ۳. خروج از حساب
        if path == "/api/auth/logout":
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:].strip()
                conn = get_db_connection()
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                conn.close()
            return self.send_json(200, {"message": "با موفقیت از حساب کاربری خارج شدید."})

        # ۴. بازیابی رمز عبور (حالت آزمایشی شفاف بدون ادعای ارسال واقعی پیامک)
        if path == "/api/auth/recover-request":
            identifier = to_en_digits((body.get("identifier") or "").strip())
            conn = get_db_connection()
            try:
                user = conn.execute(
                    "SELECT * FROM users WHERE phone = ? OR LOWER(email) = LOWER(?)",
                    (identifier, identifier),
                ).fetchone()
                if not user:
                    return self.send_json(
                        404,
                        {
                            "error": "حساب کاربری با این شماره همراه یا ایمیل در سامانه یافت نشد."
                        },
                    )
                demo_code = str(secrets.randbelow(899999) + 100000)
                expires = (iran_now() + datetime.timedelta(minutes=15)).isoformat()
                conn.execute(
                    "INSERT INTO password_resets (user_id, identifier, demo_code, expires_at, used) VALUES (?, ?, ?, ?, 0)",
                    (user["id"], identifier, demo_code, expires),
                )
                conn.commit()
                return self.send_json(
                    200,
                    {
                        "message": "حالت آزمایشی: از آنجا که سرویس پیامک/ایمیل بیرونی متصل نیست، کد بازیابی آزمایشی در همین کادر نمایش داده شده است.",
                        "demo_mode": True,
                        "demo_code": demo_code,
                        "identifier": identifier,
                    },
                )
            finally:
                conn.close()

        if path == "/api/auth/recover-confirm":
            identifier = to_en_digits((body.get("identifier") or "").strip())
            code = to_en_digits((body.get("code") or "").strip())
            new_password = body.get("new_password") or ""
            if len(new_password) < 6:
                return self.send_json(
                    400, {"error": "رمز عبور جدید باید حداقل ۶ کاراکتر باشد."}
                )

            conn = get_db_connection()
            try:
                row = conn.execute(
                    """
                    SELECT * FROM password_resets
                    WHERE identifier = ? AND demo_code = ? AND used = 0
                    ORDER BY id DESC LIMIT 1
                    """,
                    (identifier, code),
                ).fetchone()
                if not row:
                    return self.send_json(
                        400, {"error": "کد بازیابی واردشده نامعتبر یا منقضی است."}
                    )
                if datetime.datetime.fromisoformat(row["expires_at"]) <= iran_now():
                    return self.send_json(400, {"error": "کد بازیابی منقضی شده است؛ کد جدید دریافت کنید."})
                conn.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (hash_password(new_password), row["user_id"]),
                )
                conn.execute(
                    "UPDATE password_resets SET used = 1 WHERE user_id = ?", (row["user_id"],)
                )
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["user_id"],))
                conn.commit()
                return self.send_json(
                    200,
                    {
                        "message": "رمز عبور شما با موفقیت بازنشانی شد. اکنون می‌توانید وارد شوید."
                    },
                )
            finally:
                conn.close()

        # ۵. ویرایش پروفایل و رمز عبور توسط کاربر
        if path == "/api/profile/update":
            conn = get_db_connection()
            try:
                user = self.get_current_user(conn)
                if not user:
                    return self.send_json(401, {"error": "نیاز به ورود به حساب کاربری."})
                name = (body.get("name") or user["name"]).strip()
                email = (body.get("email") or user["email"] or "").strip() or None
                new_password = body.get("new_password") or ""

                if email:
                    email = email.lower()
                    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                        return self.send_json(400, {"error": "نشانی ایمیل نامعتبر است."})
                    if conn.execute("SELECT id FROM users WHERE LOWER(email) = ? AND id != ?", (email, user["id"])).fetchone():
                        return self.send_json(409, {"error": "این نشانی ایمیل متعلق به حساب دیگری است."})

                if len(name) < 3:
                    return self.send_json(400, {"error": "نام باید حداقل ۳ کاراکتر باشد."})

                if new_password:
                    if len(new_password) < 6:
                        return self.send_json(
                            400, {"error": "رمز عبور جدید باید حداقل ۶ کاراکتر باشد."}
                        )
                    conn.execute(
                        "UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = ?",
                        (name, email, hash_password(new_password), user["id"]),
                    )
                else:
                    conn.execute(
                        "UPDATE users SET name = ?, email = ? WHERE id = ?",
                        (name, email, user["id"]),
                    )
                conn.commit()
                return self.send_json(
                    200,
                    {
                        "message": "اطلاعات حساب کاربری با موفقیت به‌روزرسانی شد.",
                        "user": {
                            "id": user["id"],
                            "name": name,
                            "phone": user["phone"],
                            "email": email,
                            "role": user["role"],
                        },
                    },
                )
            finally:
                conn.close()

        # ۶. ثبت نوبت جدید با قفل اتمیک (BEGIN IMMEDIATE) برای جلوگیری ۱۰۰٪ از رزرو هم‌زمان
        if path == "/api/appointments":
            with DB_LOCK:
                conn = get_db_connection(isolation_level=None)
                try:
                    user = self.get_current_user(conn)
                    if not user:
                        return self.send_json(401, {"error": "برای ثبت و پیگیری نوبت، ابتدا وارد حساب کاربری خود شوید."})
                    service_id = int(body.get("service_id") or 0)
                    doctor_id = int(body.get("doctor_id") or 0)
                    jalali_date_raw = (body.get("jalali_date") or "").strip()
                    start_time = to_en_digits((body.get("start_time") or "").strip())
                    notes = (body.get("notes") or "").strip()
                    patient_name = (
                        body.get("patient_name") or (user["name"] if user else "")
                    ).strip()
                    patient_phone = to_en_digits(
                        (
                            body.get("patient_phone")
                            or (user["phone"] if user and user["phone"] else "")
                        ).strip()
                    )

                    if not (service_id and doctor_id and jalali_date_raw and start_time):
                        return self.send_json(
                            400,
                            {
                                "error": "لطفاً خدمت، پزشک، تاریخ شمسی و ساعت نوبت را کامل انتخاب کنید."
                            },
                        )
                    if len(patient_name) < 3 or not re.match(
                        r"^09\d{9}$", re.sub(r"\D", "", patient_phone)
                    ):
                        return self.send_json(
                            400,
                            {
                                "error": "لطفاً نام کامل و شماره همراه ۱۱ رقمی معتبر (۰۹xxxxxxxxx) وارد نمایید."
                            },
                        )

                    _, _, _, norm_date = parse_jalali_date(jalali_date_raw)

                    # آغاز تراکنش اتمیک فوری در SQLite
                    conn.execute("BEGIN IMMEDIATE")

                    day_info = compute_day_slots(conn, service_id, doctor_id, norm_date)
                    if day_info["is_holiday"]:
                        conn.execute("ROLLBACK")
                        return self.send_json(
                            409,
                            {
                                "error": f"مطب در تاریخ انتخاب‌شده به علت «{day_info['holiday_reason']}» تعطیل است.",
                                "code": "HOLIDAY_CONFLICT",
                                "alternatives": find_alternative_slots(
                                    conn, service_id, doctor_id, norm_date
                                ),
                            },
                        )
                    if not day_info["doctor_working"]:
                        conn.execute("ROLLBACK")
                        return self.send_json(
                            409,
                            {
                                "error": "پزشک انتخاب‌شده در این روز هفته برنامه حضور ندارد.",
                                "code": "DOCTOR_OFF",
                                "alternatives": find_alternative_slots(
                                    conn, service_id, doctor_id, norm_date
                                ),
                            },
                        )

                    # بررسی مستقیم تداخل بازه زمانی در پایگاه داده
                    duration_min = day_info["duration_min"]
                    buffer_min = day_info["buffer_min"]
                    req_start = time_to_minutes(start_time)
                    req_service_end = req_start + duration_min
                    req_buffered_end = req_service_end + buffer_min

                    # بررسی قرارگیری در شیفت پزشک و نبود مسدودی
                    matching_slot = None
                    for s in day_info["slots"]:
                        if s["start_time"] == start_time:
                            matching_slot = s
                            break

                    if not matching_slot or matching_slot["status"] != "available":
                        conn.execute("ROLLBACK")
                        alts = find_alternative_slots(
                            conn, service_id, doctor_id, norm_date
                        )
                        reason_msg = (
                            "این بازه زمانی لحظاتی پیش توسط مراجع دیگری رزرو شد."
                            if (matching_slot and matching_slot["status"] == "booked")
                            else "این بازه زمانی در دسترس نیست یا مسدود شده است."
                        )
                        return self.send_json(
                            409,
                            {
                                "error": f"{reason_msg} لطفاً یکی از ساعت‌های آزاد پیشنهادی زیر را انتخاب فرمایید.",
                                "code": "SLOT_CONFLICT",
                                "alternatives": alts,
                            },
                        )

                    uid = user["id"]
                    tracking_code = f"AVD-1405-{secrets.randbelow(89999) + 10000}"
                    now_iso = iran_now().isoformat()
                    end_time_str = minutes_to_time(req_service_end)

                    cur = conn.execute(
                        """
                        INSERT INTO appointments (
                            tracking_code, user_id, patient_name, patient_phone,
                            service_id, doctor_id, jalali_date, start_time, end_time,
                            duration_min, buffer_min, status, notes, reschedule_count,
                            created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 0, ?, ?)
                        """,
                        (
                            tracking_code,
                            uid,
                            patient_name,
                            patient_phone,
                            service_id,
                            doctor_id,
                            norm_date,
                            start_time,
                            end_time_str,
                            duration_min,
                            buffer_min,
                            notes,
                            now_iso,
                            now_iso,
                        ),
                    )
                    appt_id = cur.lastrowid

                    conn.execute(
                        """
                        INSERT INTO notifications (user_id, title, body, type, link_route, is_read, created_at)
                        VALUES (?, ?, ?, 'appointment', '/dashboard', 0, ?)
                        """,
                        (
                            uid,
                            f"ثبت موفق نوبت ({tracking_code})",
                            f"نوبت شما برای تاریخ {format_jalali_human(norm_date)} ساعت {to_fa_digits(start_time)} با موفقیت ثبت شد.",
                            now_iso,
                        ),
                    )
                    conn.execute("COMMIT"); sync_db_to_workspace()

                    srv_row = conn.execute(
                        "SELECT title, price_sample FROM services WHERE id = ?",
                        (service_id,),
                    ).fetchone()
                    doc_row = conn.execute(
                        "SELECT name, specialty FROM doctors WHERE id = ?",
                        (doctor_id,),
                    ).fetchone()

                    return self.send_json(
                        201,
                        {
                            "message": "نوبت شما با موفقیت ثبت و نهایی شد.",
                            "appointment": {
                                "id": appt_id,
                                "tracking_code": tracking_code,
                                "patient_name": patient_name,
                                "patient_phone": patient_phone,
                                "service_id": service_id,
                                "service_title": srv_row["title"],
                                "price_sample": srv_row["price_sample"],
                                "doctor_id": doctor_id,
                                "doctor_name": doc_row["name"],
                                "doctor_specialty": doc_row["specialty"],
                                "jalali_date": norm_date,
                                "human_date": format_jalali_human(norm_date),
                                "start_time": start_time,
                                "end_time": end_time_str,
                                "duration_min": duration_min,
                                "buffer_min": buffer_min,
                                "status": "confirmed",
                            },
                        },
                    )
                except Exception as e:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        pass
                    return self.send_json(400, {"error": str(e)})
                finally:
                    conn.close()

        # ۷. لغو نوبت (توسط مراجع یا مدیر با بررسی قوانین مطب)
        if path == "/api/appointments/cancel":
            conn = get_db_connection()
            try:
                user = self.get_current_user(conn)
                if not user:
                    return self.send_json(401, {"error": "لطفاً وارد حساب خود شوید."})
                conn.execute("BEGIN IMMEDIATE")
                appt_id = int(body.get("appointment_id") or 0)
                appt = conn.execute(
                    "SELECT * FROM appointments WHERE id = ?", (appt_id,)
                ).fetchone()
                if not appt:
                    return self.send_json(404, {"error": "نوبت مورد نظر یافت نشد."})

                if user["role"] == "patient" and appt["user_id"] != user["id"]:
                    return self.send_json(
                        403, {"error": "شما تنها مجاز به مدیریت نوبت‌های خودتان هستید."}
                    )
                if appt["status"] not in ("confirmed", "pending", "rescheduled"):
                    return self.send_json(409, {"error": "فقط نوبت فعال قابل لغو است."})

                settings = get_all_settings(conn)
                rules = settings.get("scheduling_rules", {})
                min_cancel_hours = int(rules.get("min_hours_before_cancel", 12))

                if user["role"] == "patient":
                    appt_dt = jalali_datetime_from_str(
                        appt["jalali_date"], appt["start_time"]
                    )
                    hours_left = (appt_dt - iran_now()).total_seconds() / 3600.0
                    if hours_left < min_cancel_hours:
                        return self.send_json(
                            400,
                            {
                                "error": f"طبق قوانین مطب، لغو آنلاین نوبت باید حداقل {to_fa_digits(min_cancel_hours)} ساعت پیش از زمان ویزیت انجام شود. برای موارد فوری با پذیرش تماس بگیرید."
                            },
                        )

                now_iso = iran_now().isoformat()
                # ذخیره در سطل بازیابی برای امکان بازگردانی
                conn.execute(
                    "INSERT INTO trash_bin (entity_type, entity_id, title, snapshot_json, deleted_by, deleted_at) VALUES ('appointment_cancel', ?, ?, ?, ?, ?)",
                    (
                        appt["id"],
                        f"نوبت {appt['tracking_code']} - {appt['patient_name']}",
                        json.dumps(dict(appt), ensure_ascii=False),
                        user["name"],
                        now_iso,
                    ),
                )
                conn.execute(
                    "UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?",
                    (now_iso, appt_id),
                )
                conn.execute(
                    "INSERT INTO notifications (user_id, title, body, type, link_route, is_read, created_at) VALUES (?, ?, ?, 'appointment', '/dashboard', 0, ?)",
                    (
                        appt["user_id"],
                        f"لغو نوبت {appt['tracking_code']}",
                        f"نوبت مورخ {format_jalali_human(appt['jalali_date'])} ساعت {to_fa_digits(appt['start_time'])} لغو شد.",
                        now_iso,
                    ),
                )
                conn.commit()
                return self.send_json(
                    200, {"message": f"نوبت {appt['tracking_code']} با موفقیت لغو شد."}
                )
            finally:
                conn.close()

        # ۸. جابه‌جایی نوبت (Reschedule) با بررسی قوانین و قفل اتمیک
        if path == "/api/appointments/reschedule":
            with DB_LOCK:
                conn = get_db_connection(isolation_level=None)
                try:
                    user = self.get_current_user(conn)
                    if not user:
                        return self.send_json(
                            401, {"error": "لطفاً وارد حساب کاربری خود شوید."}
                        )
                    appt_id = int(body.get("appointment_id") or 0)
                    new_date_raw = (body.get("new_jalali_date") or "").strip()
                    new_start = to_en_digits((body.get("new_start_time") or "").strip())

                    _, _, _, norm_new_date = parse_jalali_date(new_date_raw)
                    conn.execute("BEGIN IMMEDIATE")

                    appt = conn.execute(
                        "SELECT * FROM appointments WHERE id = ?", (appt_id,)
                    ).fetchone()
                    if not appt:
                        conn.execute("ROLLBACK")
                        return self.send_json(404, {"error": "نوبت مورد نظر یافت نشد."})

                    if user["role"] == "patient" and appt["user_id"] != user["id"]:
                        conn.execute("ROLLBACK")
                        return self.send_json(403, {"error": "دسترسی غیرمجاز."})
                    if appt["status"] not in ("confirmed", "pending", "rescheduled"):
                        conn.execute("ROLLBACK")
                        return self.send_json(409, {"error": "فقط نوبت فعال قابل جابه‌جایی است."})

                    settings = get_all_settings(conn)
                    rules = settings.get("scheduling_rules", {})
                    min_resched_hours = int(rules.get("min_hours_before_reschedule", 6))
                    max_reschedules = int(rules.get("max_reschedules", 2))

                    if user["role"] == "patient":
                        if int(appt["reschedule_count"]) >= max_reschedules:
                            conn.execute("ROLLBACK")
                            return self.send_json(
                                400,
                                {
                                    "error": f"حداکثر تعداد مجاز جابه‌جایی برای هر نوبت ({to_fa_digits(max_reschedules)} بار) به پایان رسیده است."
                                },
                            )
                        appt_dt = jalali_datetime_from_str(
                            appt["jalali_date"], appt["start_time"]
                        )
                        hours_left = (appt_dt - iran_now()).total_seconds() / 3600.0
                        if hours_left < min_resched_hours:
                            conn.execute("ROLLBACK")
                            return self.send_json(
                                400,
                                {
                                    "error": f"جابه‌جایی آنلاین نوبت تا {to_fa_digits(min_resched_hours)} ساعت مانده به زمان نوبت امکان‌پذیر است."
                                },
                            )

                    day_info = compute_day_slots(
                        conn, appt["service_id"], appt["doctor_id"], norm_new_date,
                        exclude_appointment_id=appt_id,
                        duration_override=appt["duration_min"], buffer_override=appt["buffer_min"],
                    )
                    if norm_new_date == appt["jalali_date"] and new_start == appt["start_time"]:
                        conn.execute("ROLLBACK")
                        return self.send_json(200, {"message": "زمان نوبت تغییری نکرده است."})
                    target_slot = next(
                        (s for s in day_info["slots"] if s["start_time"] == new_start),
                        None,
                    )
                    if not target_slot or target_slot["status"] != "available":
                        conn.execute("ROLLBACK")
                        return self.send_json(
                            409,
                            {
                                "error": "ساعت جدید انتخاب‌شده آزاد نیست. لطفاً ساعت دیگری را انتخاب کنید.",
                                "alternatives": find_alternative_slots(
                                    conn,
                                    appt["service_id"],
                                    appt["doctor_id"],
                                    norm_new_date,
                                ),
                            },
                        )

                    new_end = minutes_to_time(
                        time_to_minutes(new_start) + int(appt["duration_min"])
                    )
                    now_iso = iran_now().isoformat()
                    conn.execute(
                        """
                        UPDATE appointments
                        SET jalali_date = ?, start_time = ?, end_time = ?,
                            status = 'rescheduled', reschedule_count = reschedule_count + 1, updated_at = ?
                        WHERE id = ?
                        """,
                        (norm_new_date, new_start, new_end, now_iso, appt_id),
                    )
                    conn.execute(
                        """
                        INSERT INTO notifications (user_id, title, body, type, link_route, is_read, created_at)
                        VALUES (?, ?, ?, 'appointment', '/dashboard', 0, ?)
                        """,
                        (
                            appt["user_id"],
                            f"جابه‌جایی نوبت {appt['tracking_code']}",
                            f"نوبت شما به تاریخ {format_jalali_human(norm_new_date)} ساعت {to_fa_digits(new_start)} منتقل شد.",
                            now_iso,
                        ),
                    )
                    conn.execute("COMMIT"); sync_db_to_workspace()
                    return self.send_json(
                        200,
                        {
                            "message": f"نوبت شما با موفقیت به {format_jalali_human(norm_new_date)} ساعت {to_fa_digits(new_start)} منتقل شد."
                        },
                    )
                except Exception as e:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        pass
                    return self.send_json(400, {"error": str(e)})
                finally:
                    conn.close()

        # ۹. ثبت درخواست مشاوره آنلاین و ارسال پیام در گفت‌وگو
        if path == "/api/consultations":
            conn = get_db_connection()
            try:
                user = self.get_current_user(conn)
                if not user:
                    return self.send_json(
                        401,
                        {
                            "error": "برای حفظ محرمانگی پرونده و پیگیری پاسخ پزشک، لطفاً ابتدا وارد حساب کاربری خود شوید."
                        },
                    )
                subject = (body.get("subject") or "").strip()
                message = (body.get("message") or "").strip()
                service_id = body.get("service_id") or None
                doctor_id = body.get("doctor_id") or None
                urgency = (body.get("urgency") or "عادی").strip()

                if len(subject) < 4 or len(message) < 10:
                    return self.send_json(
                        400,
                        {
                            "error": "لطفاً موضوع مشاوره و شرح کامل پرسش خود (حداقل ۱۰ کاراکتر) را بنویسید."
                        },
                    )

                now_iso = iran_now().isoformat()
                tracking_code = f"CNS-1405-{secrets.randbelow(8999) + 1000}"
                cur = conn.execute(
                    """
                    INSERT INTO consultations (
                        tracking_code, user_id, patient_name, patient_phone,
                        service_id, doctor_id, subject, urgency, status,
                        unread_by_patient, unread_by_staff, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?)
                    """,
                    (
                        tracking_code,
                        user["id"],
                        user["name"],
                        user["phone"] or user["email"] or "",
                        service_id,
                        doctor_id,
                        subject,
                        urgency,
                        now_iso,
                        now_iso,
                    ),
                )
                cid = cur.lastrowid
                conn.execute(
                    """
                    INSERT INTO consultation_messages (
                        consultation_id, sender_id, sender_name, sender_role, message, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (cid, user["id"], user["name"], user["role"], message, now_iso),
                )
                conn.commit()
                return self.send_json(
                    201,
                    {
                        "message": "درخواست مشاوره آنلاین شما با موفقیت ثبت شد و در نوبت بررسی پزشک قرار گرفت.",
                        "tracking_code": tracking_code,
                        "consultation_id": cid,
                    },
                )
            finally:
                conn.close()

        if path == "/api/consultations/reply":
            conn = get_db_connection()
            try:
                user = self.get_current_user(conn)
                if not user:
                    return self.send_json(401, {"error": "لطفاً وارد حساب خود شوید."})
                cid = int(body.get("consultation_id") or 0)
                message = (body.get("message") or "").strip()
                new_status = body.get("status")

                if len(message) < 2:
                    return self.send_json(400, {"error": "متن پیام نمی‌تواند خالی باشد."})

                consult = conn.execute(
                    "SELECT * FROM consultations WHERE id = ?", (cid,)
                ).fetchone()
                if not consult:
                    return self.send_json(404, {"error": "گفت‌وگوی مشاوره یافت نشد."})

                if user["role"] == "patient" and consult["user_id"] != user["id"]:
                    return self.send_json(403, {"error": "دسترسی غیرمجاز به گفت‌وگوی دیگران."})

                now_iso = iran_now().isoformat()
                conn.execute(
                    """
                    INSERT INTO consultation_messages (
                        consultation_id, sender_id, sender_name, sender_role, message, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (cid, user["id"], user["name"], user["role"], message, now_iso),
                )

                if user["role"] in ("admin", "doctor"):
                    status_val = new_status if new_status in ("answered", "closed", "pending") else "answered"
                    conn.execute(
                        "UPDATE consultations SET status = ?, unread_by_patient = 1, unread_by_staff = 0, updated_at = ? WHERE id = ?",
                        (status_val, now_iso, cid),
                    )
                    conn.execute(
                        "INSERT INTO notifications (user_id, title, body, type, link_route, is_read, created_at) VALUES (?, ?, ?, 'consultation', '/dashboard', 0, ?)",
                        (
                            consult["user_id"],
                            f"پاسخ جدید در مشاوره {consult['tracking_code']}",
                            f"{user['name']} به گفت‌وگوی مشاوره «{consult['subject']}» پاسخ داد.",
                            now_iso,
                        ),
                    )
                else:
                    conn.execute(
                        "UPDATE consultations SET status = 'pending', unread_by_staff = 1, unread_by_patient = 0, updated_at = ? WHERE id = ?",
                        (now_iso, cid),
                    )

                conn.commit()
                return self.send_json(200, {"message": "پیام شما در گفت‌وگو ثبت شد."})
            finally:
                conn.close()

        # ۱۰. ثبت تیکت پشتیبانی و پاسخ‌گویی
        if path == "/api/support":
            conn = get_db_connection()
            try:
                user = self.get_current_user(conn)
                name = (body.get("name") or (user["name"] if user else "")).strip()
                contact = to_en_digits(
                    (
                        body.get("contact")
                        or (user["phone"] or user["email"] if user else "")
                    ).strip()
                )
                subject = (body.get("subject") or "").strip()
                category = (body.get("category") or "عمومی").strip()
                message = (body.get("message") or "").strip()

                if len(name) < 3 or len(contact) < 5 or len(subject) < 3 or len(message) < 5:
                    return self.send_json(
                        400,
                        {"error": "لطفاً نام، راه ارتباطی، موضوع و متن پیام را کامل وارد نمایید."},
                    )

                uid = user["id"] if user else None
                now_iso = iran_now().isoformat()
                tracking_code = f"SUP-1405-{secrets.randbelow(8999) + 1000}"
                cur = conn.execute(
                    """
                    INSERT INTO support_tickets (
                        tracking_code, user_id, name, contact, subject, category,
                        status, unread_by_patient, unread_by_staff, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?)
                    """,
                    (tracking_code, uid, name, contact, subject, category, now_iso, now_iso),
                )
                tid = cur.lastrowid
                conn.execute(
                    """
                    INSERT INTO support_messages (
                        ticket_id, sender_id, sender_name, sender_role, message, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (tid, uid, name, user["role"] if user else "patient", message, now_iso),
                )
                conn.commit()
                return self.send_json(
                    201,
                    {
                        "message": ("پیام پشتیبانی شما ثبت شد و قابل پیگیری در داشبورد است." if user else
                                    "پیام پشتیبانی شما ثبت شد؛ کد پیگیری را نگه دارید. پاسخ از راه ارتباطی واردشده با هماهنگی پذیرش پیگیری می‌شود."),
                        "tracking_code": tracking_code,
                        "ticket_id": tid,
                    },
                )
            finally:
                conn.close()

        if path == "/api/support/reply":
            conn = get_db_connection()
            try:
                user = self.get_current_user(conn)
                if not user:
                    return self.send_json(401, {"error": "لطفاً وارد حساب خود شوید."})
                tid = int(body.get("ticket_id") or 0)
                message = (body.get("message") or "").strip()
                new_status = body.get("status")

                ticket = conn.execute(
                    "SELECT * FROM support_tickets WHERE id = ?", (tid,)
                ).fetchone()
                if not ticket:
                    return self.send_json(404, {"error": "تیکت پشتیبانی یافت نشد."})
                if user["role"] == "patient" and ticket["user_id"] != user["id"]:
                    return self.send_json(403, {"error": "دسترسی غیرمجاز."})
                if len(message) < 2:
                    return self.send_json(400, {"error": "متن پیام نمی‌تواند خالی باشد."})

                now_iso = iran_now().isoformat()
                conn.execute(
                    """
                    INSERT INTO support_messages (
                        ticket_id, sender_id, sender_name, sender_role, message, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (tid, user["id"], user["name"], user["role"], message, now_iso),
                )
                if user["role"] in ("admin", "doctor"):
                    st = new_status if new_status in ("answered", "closed", "pending") else "answered"
                    conn.execute(
                        "UPDATE support_tickets SET status = ?, unread_by_patient = 1, unread_by_staff = 0, updated_at = ? WHERE id = ?",
                        (st, now_iso, tid),
                    )
                    if ticket["user_id"]:
                        conn.execute(
                            "INSERT INTO notifications (user_id, title, body, type, link_route, is_read, created_at) VALUES (?, ?, ?, 'support', '/dashboard', 0, ?)",
                            (
                                ticket["user_id"],
                                f"پاسخ پشتیبانی ({ticket['tracking_code']})",
                                f"پشتیبانی مطب آویدا به درخواست «{ticket['subject']}» پاسخ داد.",
                                now_iso,
                            ),
                        )
                else:
                    conn.execute(
                        "UPDATE support_tickets SET status = 'pending', unread_by_staff = 1, unread_by_patient = 0, updated_at = ? WHERE id = ?",
                        (now_iso, tid),
                    )
                conn.commit()
                return self.send_json(200, {"message": "پاسخ پشتیبانی با موفقیت ارسال شد."})
            finally:
                conn.close()

        # ۱۱. خواندن اعلان‌ها
        if path == "/api/notifications/read":
            conn = get_db_connection()
            try:
                user = self.get_current_user(conn)
                if not user:
                    return self.send_json(401, {"error": "نیاز به ورود."})
                conn.execute(
                    "UPDATE notifications SET is_read = 1 WHERE user_id = ?",
                    (user["id"],),
                )
                conn.execute(
                    "UPDATE consultations SET unread_by_patient = 0 WHERE user_id = ?",
                    (user["id"],),
                )
                conn.execute(
                    "UPDATE support_tickets SET unread_by_patient = 0 WHERE user_id = ?",
                    (user["id"],),
                )
                conn.commit()
                return self.send_json(200, {"message": "همه اعلان‌ها به حالت خوانده‌شده درآمدند."})
            finally:
                conn.close()

        # ۱۲. عملیات پنل مدیریت صاحب مطب (/api/admin/...)
        if path.startswith("/api/admin/"):
            return self.handle_admin_post(path, body)

        return self.send_json(404, {"error": "مسیر درخواستی یافت نشد."})

    def handle_admin_post(self, path: str, body: dict):
        conn = get_db_connection()
        try:
            user = self.get_current_user(conn)
            if not user or user["role"] not in ("admin", "doctor"):
                return self.send_json(
                    403, {"error": "دسترسی محدود به مدیر و پرسنل مجاز مطب است."}
                )

            now_iso = iran_now().isoformat()

            # الف) افزودن یا ویرایش خدمت
            if path == "/api/admin/service/save":
                sid = body.get("id")
                title = (body.get("title") or "").strip()
                category = (body.get("category") or "عمومی").strip()
                short_desc = (body.get("short_desc") or "").strip()
                full_desc = (body.get("full_desc") or short_desc).strip()
                duration_min = int(body.get("duration_min", 45))
                price_sample = (body.get("price_sample") or "").strip()
                prep_tips = (body.get("prep_tips") or "مراجعه ۱۵ دقیقه پیش از نوبت.").strip()
                aftercare_tips = (body.get("aftercare_tips") or "رعایت بهداشت دهان طبق توصیه پزشک.").strip()
                model_type = (body.get("model_type") or "implant").strip()
                active = 1 if body.get("active", True) else 0

                if len(title) < 3 or not price_sample:
                    return self.send_json(
                        400, {"error": "عنوان خدمت و هزینه نمونه الزامی است."}
                    )
                if not 1 <= duration_min <= 1440:
                    return self.send_json(400, {"error": "مدت خدمت باید بین ۱ تا ۱۴۴۰ دقیقه باشد."})

                if sid:
                    conn.execute(
                        """
                        UPDATE services
                        SET title=?, category=?, short_desc=?, full_desc=?, duration_min=?,
                            price_sample=?, prep_tips=?, aftercare_tips=?, model_type=?, active=?
                        WHERE id=?
                        """,
                        (
                            title,
                            category,
                            short_desc,
                            full_desc,
                            duration_min,
                            price_sample,
                            prep_tips,
                            aftercare_tips,
                            model_type,
                            active,
                            int(sid),
                        ),
                    )
                    msg = f"خدمت «{title}» با موفقیت ویرایش شد و در سایت عمومی اعمال گردید."
                else:
                    slug = f"service-{secrets.token_hex(3)}"
                    conn.execute(
                        """
                        INSERT INTO services (
                            slug, title, category, short_desc, full_desc, duration_min,
                            price_sample, prep_tips, aftercare_tips, model_type, featured, active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                        """,
                        (
                            slug,
                            title,
                            category,
                            short_desc,
                            full_desc,
                            duration_min,
                            price_sample,
                            prep_tips,
                            aftercare_tips,
                            model_type,
                            active,
                        ),
                    )
                    msg = f"خدمت جدید «{title}» با موفقیت به مطب اضافه شد."
                conn.commit()
                return self.send_json(200, {"message": msg})

            # ب) افزودن یا ویرایش پزشک و برنامه حضور
            if path == "/api/admin/doctor/save":
                did = body.get("id")
                name = (body.get("name") or "").strip()
                specialty = (body.get("specialty") or "").strip()
                medical_code = (body.get("medical_code") or "کد نمونه آزمایشی").strip()
                bio = (body.get("bio") or "").strip()
                experience_note = (body.get("experience_note") or "تجربه بالینی نمونه").strip()
                avatar_theme = (body.get("avatar_theme") or "emerald").strip()
                schedule_obj = body.get("schedule") or {}
                active = 1 if body.get("active", True) else 0

                if len(name) < 3 or len(specialty) < 3:
                    return self.send_json(
                        400, {"error": "نام پزشک و تخصص الزامی است."}
                    )
                validate_schedule(schedule_obj)

                sched_json = json.dumps(schedule_obj, ensure_ascii=False)
                if did:
                    conn.execute(
                        """
                        UPDATE doctors
                        SET name=?, specialty=?, medical_code=?, bio=?, experience_note=?,
                            avatar_theme=?, schedule_json=?, active=?
                        WHERE id=?
                        """,
                        (
                            name,
                            specialty,
                            medical_code,
                            bio,
                            experience_note,
                            avatar_theme,
                            sched_json,
                            active,
                            int(did),
                        ),
                    )
                    msg = f"اطلاعات و برنامه حضور «{name}» با موفقیت به‌روزرسانی شد."
                else:
                    slug = f"doc-{secrets.token_hex(3)}"
                    conn.execute(
                        """
                        INSERT INTO doctors (
                            slug, name, specialty, medical_code, bio, experience_note,
                            avatar_theme, schedule_json, active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            slug,
                            name,
                            specialty,
                            medical_code,
                            bio,
                            experience_note,
                            avatar_theme,
                            sched_json,
                            active,
                        ),
                    )
                    msg = f"پزشک جدید «{name}» با موفقیت اضافه شد."
                conn.commit()
                return self.send_json(200, {"message": msg})

            # ج) تغییر وضعیت نوبت در پنل مدیریت
            if path == "/api/admin/appointment/status":
                appt_id = int(body.get("appointment_id") or 0)
                new_status = (body.get("status") or "").strip()
                if new_status not in ("confirmed", "pending", "cancelled", "completed"):
                    return self.send_json(400, {"error": "وضعیت نامعتبر است."})
                appt = conn.execute(
                    "SELECT * FROM appointments WHERE id = ?", (appt_id,)
                ).fetchone()
                if not appt:
                    return self.send_json(404, {"error": "نوبت یافت نشد."})

                conn.execute("BEGIN IMMEDIATE")
                # بررسی دوباره پس از گرفتن قفل نوشتن، برای جلوگیری از تأیید هم‌زمان یک بازه.
                appt = conn.execute("SELECT * FROM appointments WHERE id = ?", (appt_id,)).fetchone()
                if new_status in ("confirmed", "pending") and not appointment_slot_available(conn, appt):
                    return self.send_json(409, {"error": "این بازه دیگر آزاد نیست؛ ابتدا زمان نوبت را بررسی کنید."})

                conn.execute(
                    "INSERT INTO trash_bin (entity_type, entity_id, title, snapshot_json, deleted_by, deleted_at) VALUES ('appointment_status', ?, ?, ?, ?, ?)",
                    (
                        appt["id"],
                        f"تغییر وضعیت نوبت {appt['tracking_code']}",
                        json.dumps(dict(appt), ensure_ascii=False),
                        user["name"],
                        now_iso,
                    ),
                )
                conn.execute(
                    "UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?",
                    (new_status, now_iso, appt_id),
                )
                conn.commit()
                return self.send_json(
                    200,
                    {"message": f"وضعیت نوبت {appt['tracking_code']} با موفقیت تغییر یافت."},
                )

            # د) به‌روزرسانی تنظیمات مطب، قوانین لغو، تعطیلات و بازه‌های مسدودشده
            if path == "/api/admin/settings/save":
                section_key = (body.get("key") or "").strip()
                val_obj = body.get("value")
                if section_key not in (
                    "clinic_info",
                    "scheduling_rules",
                    "holidays",
                    "blocked_slots",
                ):
                    return self.send_json(400, {"error": "بخش تنظیمات نامعتبر است."})
                validate_settings_value(section_key, val_obj, conn)

                old_row = conn.execute(
                    "SELECT value_json FROM clinic_settings WHERE key = ?",
                    (section_key,),
                ).fetchone()
                if old_row:
                    conn.execute(
                        "INSERT INTO trash_bin (entity_type, entity_id, title, snapshot_json, deleted_by, deleted_at) VALUES ('settings', 0, ?, ?, ?, ?)",
                        (
                            f"تنظیمات بخش {section_key}",
                            json.dumps(
                                {"key": section_key, "old_value": json.loads(old_row["value_json"])},
                                ensure_ascii=False,
                            ),
                            user["name"],
                            now_iso,
                        ),
                    )

                conn.execute(
                    "INSERT OR REPLACE INTO clinic_settings (key, value_json) VALUES (?, ?)",
                    (section_key, json.dumps(val_obj, ensure_ascii=False)),
                )
                conn.commit()
                return self.send_json(
                    200,
                    {
                        "message": "تنظیمات مطب با موفقیت ذخیره شد و بلافاصله در سایت عمومی اعمال گردید."
                    },
                )

            # ه) مدیریت پرسش‌های متداول (FAQ)
            if path == "/api/admin/faq/save":
                fid = body.get("id")
                question = (body.get("question") or "").strip()
                answer = (body.get("answer") or "").strip()
                category = (body.get("category") or "عمومی").strip()
                if len(question) < 4 or len(answer) < 4:
                    return self.send_json(400, {"error": "متن پرسش و پاسخ الزامی است."})
                if fid:
                    conn.execute(
                        "UPDATE faqs SET question=?, answer=?, category=? WHERE id=?",
                        (question, answer, category, int(fid)),
                    )
                else:
                    conn.execute(
                        "INSERT INTO faqs (question, answer, category, sort_order) VALUES (?, ?, ?, 10)",
                        (question, answer, category),
                    )
                conn.commit()
                return self.send_json(200, {"message": "پرسش متداول ذخیره شد."})

            if path == "/api/admin/faq/delete":
                fid = int(body.get("id") or 0)
                row = conn.execute("SELECT * FROM faqs WHERE id = ?", (fid,)).fetchone()
                if row:
                    conn.execute(
                        "INSERT INTO trash_bin (entity_type, entity_id, title, snapshot_json, deleted_by, deleted_at) VALUES ('faq', ?, ?, ?, ?, ?)",
                        (
                            fid,
                            f"پرسش متداول: {row['question'][:35]}",
                            json.dumps(dict(row), ensure_ascii=False),
                            user["name"],
                            now_iso,
                        ),
                    )
                    conn.execute("DELETE FROM faqs WHERE id = ?", (fid,))
                    conn.commit()
                return self.send_json(
                    200, {"message": "پرسش متداول حذف شد (قابل بازیابی در سطل بازیابی)."}
                )

            # و) بازیابی عملیات حساس از سطل بازیابی (Trash / Undo)
            if path == "/api/admin/trash/restore":
                tid = int(body.get("trash_id") or 0)
                t_row = conn.execute(
                    "SELECT * FROM trash_bin WHERE id = ?", (tid,)
                ).fetchone()
                if not t_row:
                    return self.send_json(404, {"error": "مورد بازیابی یافت نشد."})
                snap = json.loads(t_row["snapshot_json"])
                etype = t_row["entity_type"]

                if etype in ("appointment_cancel", "appointment_status"):
                    conn.execute("BEGIN IMMEDIATE")
                    current_appt = conn.execute("SELECT * FROM appointments WHERE id = ?", (snap["id"],)).fetchone()
                    if not current_appt:
                        return self.send_json(404, {"error": "نوبت مورد نظر یافت نشد."})
                    if snap["status"] in ("confirmed", "pending", "rescheduled") and not appointment_slot_available(conn, current_appt):
                        return self.send_json(409, {"error": "بازیابی این نوبت با ظرفیت فعلی تداخل دارد."})
                    conn.execute(
                        "UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?",
                        (snap["status"], now_iso, snap["id"]),
                    )
                elif etype == "settings":
                    conn.execute(
                        "INSERT OR REPLACE INTO clinic_settings (key, value_json) VALUES (?, ?)",
                        (
                            snap["key"],
                            json.dumps(snap["old_value"], ensure_ascii=False),
                        ),
                    )
                elif etype == "faq":
                    conn.execute(
                        "INSERT INTO faqs (question, answer, category, sort_order) VALUES (?, ?, ?, ?)",
                        (
                            snap["question"],
                            snap["answer"],
                            snap["category"],
                            snap.get("sort_order", 5),
                        ),
                    )
                conn.execute("DELETE FROM trash_bin WHERE id = ?", (tid,))
                conn.commit()
                return self.send_json(
                    200, {"message": f"«{t_row['title']}» با موفقیت به وضعیت قبل بازیابی شد."}
                )

            return self.send_json(404, {"error": "عملیات مدیریتی یافت نشد."})
        finally:
            conn.close()


def run_server(port: int = 8080):
    init_db()
    server_address = ("127.0.0.1", port)
    httpd = http.server.ThreadingHTTPServer(server_address, AvidaRequestHandler)
    print(f"Avida Dental Clinic Server listening on http://localhost:{port}")
    sys.stdout.flush()
    httpd.serve_forever()


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    run_server(port_arg)
