"""Real HTTP/SQLite regression tests. All writes use an isolated temporary DB."""
import concurrent.futures
import datetime
import http.client
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get("AVIDA_TEST_SERVER", str(PROJECT / "server.py")))
spec = importlib.util.spec_from_file_location("avida_test_server", SOURCE)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
app.STATIC_DIR = PROJECT / "static"


class BackendTests(unittest.TestCase):
    def setUp(self):
        workspace_work = PROJECT.parents[2] / "work"
        self.temp = tempfile.TemporaryDirectory(prefix="avida-backend-", dir=workspace_work if workspace_work.is_dir() else None)
        app.DATA_DIR = Path(self.temp.name)
        app.RUNTIME_DB_PATH = app.DATA_DIR / "runtime.db"
        app.PERSIST_DB_PATH = app.DATA_DIR / "persist.db"
        app.DB_PATH = app.RUNTIME_DB_PATH
        app.init_db()
        class QuietHandler(app.AvidaRequestHandler):
            def log_message(self, *_):
                pass
        self.httpd = app.http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.admin = self.login("admin@avidadental.ir", "AvidaAdmin@1405")
        self.patient = self.login("sara.moradi@example.ir", "AvidaUser@1405")

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()

    def request(self, method, path, body=None, token=None, raw=None):
        client = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        encoded = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        client.request(method, path, body=encoded, headers=headers)
        response = client.getresponse()
        payload = response.read().decode("utf-8")
        headers = dict(response.getheaders())
        client.close()
        if headers.get("Content-Type", "").startswith("application/json"):
            payload = json.loads(payload)
        return response.status, payload, headers

    def post(self, path, body=None, token=None):
        return self.request("POST", path, body or {}, token)

    def login(self, identifier, password):
        status, data, _ = self.post("/api/auth/login", {"identifier": identifier, "password": password})
        self.assertEqual(status, 200, data)
        return data["token"]

    def sql(self, statement, values=()):
        conn = app.get_db_connection()
        try:
            cursor = conn.execute(statement, values)
            rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
            conn.commit()
            return rows
        finally:
            conn.close()

    def free_booking(self, days=2):
        date = app.iran_now().date() + datetime.timedelta(days=days)
        for offset in range(14):
            day = date + datetime.timedelta(days=offset)
            jy, jm, jd = app.gregorian_to_jalali(day.year, day.month, day.day)
            jdate = f"{jy:04d}/{jm:02d}/{jd:02d}"
            status, result, _ = self.request("GET", f"/api/slots?service_id=1&doctor_id=1&jalali_date={jdate}")
            self.assertEqual(status, 200, result)
            slot = next((s for s in result["slots"] if s["status"] == "available"), None)
            if slot:
                return {"service_id": 1, "doctor_id": 1, "jalali_date": jdate,
                        "start_time": slot["start_time"], "patient_name": "Test Patient", "patient_phone": "09123456789"}
        self.fail("No free seed slot")

    def book(self, body=None, token=None):
        body = body or self.free_booking()
        status, result, _ = self.post("/api/appointments", body, token or self.patient)
        self.assertEqual(status, 201, result)
        return result["appointment"], body

    def test_public_routes_static_and_missing(self):
        for path in ("/", "/services", "/doctors", "/booking", "/contact", "/consultation", "/auth", "/dashboard", "/admin"):
            status, page, _ = self.request("GET", path)
            self.assertEqual(status, 200, path)
            self.assertNotIn("__SEO_", page)
        self.assertEqual(self.request("GET", "/definitely-missing")[0], 404)
        self.assertEqual(self.request("GET", "/static/css/styles.css")[2]["Cache-Control"], "no-cache")
        self.assertEqual(self.request("GET", "/static/%2e%2e/server.py")[0], 404)
        for path in ("/auth", "/dashboard", "/admin"):
            self.assertIn("noindex", self.request("GET", path)[2]["X-Robots-Tag"])

    def test_expired_sessions_are_rejected(self):
        self.sql("UPDATE sessions SET expires_at=? WHERE token=?", ((app.iran_now() - datetime.timedelta(seconds=1)).isoformat(), self.patient))
        self.assertEqual(self.request("GET", "/api/dashboard", token=self.patient)[0], 401)

    def test_reset_expiry_and_session_invalidation(self):
        _, reset, _ = self.post("/api/auth/recover-request", {"identifier": "sara.moradi@example.ir"})
        self.sql("UPDATE password_resets SET expires_at=?", ((app.iran_now() - datetime.timedelta(minutes=1)).isoformat(),))
        payload = {"identifier": "sara.moradi@example.ir", "code": reset["demo_code"], "new_password": "Changed@1405"}
        self.assertEqual(self.post("/api/auth/recover-confirm", payload)[0], 400)
        _, reset, _ = self.post("/api/auth/recover-request", {"identifier": "sara.moradi@example.ir"})
        payload["code"] = reset["demo_code"]
        self.assertEqual(self.post("/api/auth/recover-confirm", payload)[0], 200)
        self.assertEqual(self.request("GET", "/api/dashboard", token=self.patient)[0], 401)
        self.login("sara.moradi@example.ir", "Changed@1405")

    def test_guest_data_is_never_assigned_to_demo_patient(self):
        self.assertEqual(self.post("/api/appointments", self.free_booking())[0], 401)
        status, ticket, _ = self.post("/api/support", {"name": "Guest Patient", "contact": "09123456789", "subject": "Guest support", "message": "Please contact me."})
        self.assertEqual(status, 201, ticket)
        row = self.sql("SELECT user_id FROM support_tickets WHERE id=?", (ticket["ticket_id"],))[0]
        self.assertIsNone(row["user_id"])

    def test_past_slots_and_invalid_dates(self):
        past = app.iran_now().date() - datetime.timedelta(days=14)
        jy, jm, jd = app.gregorian_to_jalali(past.year, past.month, past.day)
        _, info, _ = self.request("GET", f"/api/slots?service_id=1&doctor_id=1&jalali_date={jy}/{jm:02}/{jd:02}")
        self.assertFalse(any(s["status"] == "available" for s in info["slots"]))
        self.assertEqual(self.request("GET", "/api/slots?jalali_date=1404/12/30")[0], 400)
        with self.assertRaises(ValueError):
            app.time_to_minutes("25:00")

    def test_concurrent_booking_has_one_winner(self):
        payload = self.free_booking()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(lambda _: self.post("/api/appointments", payload, self.patient)[0], range(2)))
        self.assertEqual(sorted(statuses), [201, 409])

    def test_reschedule_ignores_own_interval_and_inactive_is_rejected(self):
        appointment, body = self.book()
        start = app.time_to_minutes(body["start_time"])
        payload = {"appointment_id": appointment["id"], "new_jalali_date": body["jalali_date"], "new_start_time": app.minutes_to_time(start + 30)}
        status, result, _ = self.post("/api/appointments/reschedule", payload, self.patient)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.post("/api/appointments/cancel", {"appointment_id": appointment["id"]}, self.patient)[0], 200)
        self.assertEqual(self.post("/api/appointments/reschedule", payload, self.patient)[0], 409)
        self.assertEqual(self.post("/api/appointments/cancel", {"appointment_id": appointment["id"]}, self.patient)[0], 409)

    def test_reactivation_and_undo_cannot_double_book(self):
        appointment, body = self.book()
        self.assertEqual(self.post("/api/appointments/cancel", {"appointment_id": appointment["id"]}, self.patient)[0], 200)
        self.book(body)
        self.assertEqual(self.post("/api/admin/appointment/status", {"appointment_id": appointment["id"], "status": "confirmed"}, self.admin)[0], 409)
        trash = self.sql("SELECT id FROM trash_bin WHERE entity_type='appointment_cancel' AND entity_id=?", (appointment["id"],))[0]
        self.assertEqual(self.post("/api/admin/trash/restore", {"trash_id": trash["id"]}, self.admin)[0], 409)

    def test_reschedule_availability_excludes_only_authorized_own_appointment(self):
        appointment, body = self.book()
        base = f"/api/slots?service_id=1&doctor_id=1&jalali_date={body['jalali_date']}"
        query = base + f"&appointment_id={appointment['id']}"
        target = app.minutes_to_time(app.time_to_minutes(body["start_time"]) + 30)
        _, normal, _ = self.request("GET", base, token=self.patient)
        self.assertEqual(next(slot for slot in normal["slots"] if slot["start_time"] == target)["status"], "booked")
        self.assertEqual(self.request("GET", query)[0], 401)
        _, stranger, _ = self.post("/api/auth/register", {"name": "Other Patient", "identifier": "other@example.ir", "password": "Password@123"})
        self.assertEqual(self.request("GET", query, token=stranger["token"])[0], 403)
        self.assertEqual(self.request("GET", query.replace("doctor_id=1", "doctor_id=2"), token=self.patient)[0], 400)
        for token in (self.patient, self.admin):
            status, available, _ = self.request("GET", query, token=token)
            self.assertEqual(status, 200, available)
            self.assertEqual(next(slot for slot in available["slots"] if slot["start_time"] == target)["status"], "available")

    def test_admin_invalid_schedule_rules_are_not_persisted(self):
        cases = [("scheduling_rules", {"slot_step_minutes": 0}), ("scheduling_rules", {"buffer_minutes": -1}), ("holidays", {}), ("blocked_slots", [{"jalali_date": "1405/10/10", "start_time": "25:00", "end_time": "12:00"}])]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                self.assertEqual(self.post("/api/admin/settings/save", {"key": key, "value": value}, self.admin)[0], 400)
        self.assertEqual(self.post("/api/admin/service/save", {"title": "Test service", "price_sample": "sample", "duration_min": -5}, self.admin)[0], 400)
        self.assertEqual(self.post("/api/admin/doctor/save", {"name": "Test Doctor", "specialty": "Test specialty", "schedule": {"0": {"active": True, "start": "19:00", "end": "09:00"}}}, self.admin)[0], 400)

    def test_consultation_support_replies_and_private_ownership(self):
        _, stranger, _ = self.post("/api/auth/register", {"name": "Other Patient", "identifier": "other@example.ir", "password": "Password@123"})
        stranger_token = stranger["token"]
        for create, reply, id_key in (("/api/consultations", "/api/consultations/reply", "consultation_id"), ("/api/support", "/api/support/reply", "ticket_id")):
            body = {"name": "Test Patient", "contact": "09123456789", "subject": "Test request", "message": "A sufficiently detailed test message."}
            status, result, _ = self.post(create, body, self.patient)
            self.assertEqual(status, 201, result)
            payload = {id_key: result[id_key], "message": "Reply message", "status": "answered"}
            self.assertEqual(self.post(reply, payload, stranger_token)[0], 403)
            self.assertEqual(self.post(reply, payload, self.admin)[0], 200)
            _, dashboard, _ = self.request("GET", "/api/dashboard", token=self.patient)
            collection = "consultations" if id_key == "consultation_id" else "support_tickets"
            target = next(item for item in dashboard[collection] if item["id"] == result[id_key])
            self.assertEqual(target["status"], "answered")
            self.assertEqual(len(target["messages"]), 2)
        self.assertEqual(self.request("GET", "/api/admin/overview", token=self.patient)[0], 403)
        self.assertEqual(self.post("/api/admin/settings/save", {"key": "clinic_info", "value": {}}, self.patient)[0], 403)

    def test_malformed_payload_and_duplicate_email_return_json_errors(self):
        for payload in (b"[]", b"null", b"42", b'{"name":42}'):
            with self.subTest(payload=payload):
                self.assertEqual(self.request("POST", "/api/auth/register", raw=payload)[0], 400)
        self.assertEqual(self.post("/api/profile/update", {"name": "Test User", "email": "admin@avidadental.ir"}, self.patient)[0], 409)
        self.assertEqual(self.post("/api/profile/update", {"name": "Test User", "email": "not-email"}, self.patient)[0], 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
