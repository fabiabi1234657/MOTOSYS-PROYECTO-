"""Run after starting the data Compose project with MOTO_TEST_PROJECT set."""
import os
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

PROJECT = os.getenv("MOTO_TEST_PROJECT")


@unittest.skipUnless(PROJECT, "Set MOTO_TEST_PROJECT to the running Compose project")
class PostgresIntegrity(unittest.TestCase):
    def sql(self, sql):
        return subprocess.run(
            ["docker", "exec", "-i", f"{PROJECT}-postgres-1", "psql",
             "-U", "motosys", "-d", "motosys", "-X", "-qAt",
             "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
            input=sql, text=True, capture_output=True, timeout=20,
        )

    def test_concurrent_normalized_email_uniqueness(self):
        email = f"verification-{uuid4().hex}@example.invalid"
        self.addCleanup(self.sql, f"DELETE FROM users WHERE email = '{email}';")
        sql = f"INSERT INTO users(email) VALUES (lower(trim('  {email.upper()} ')));"
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(self.sql, [sql, sql]))
        self.assertEqual(sorted(result.returncode for result in results), [0, 3])
        failure = next(result for result in results if result.returncode != 0)
        self.assertIn("23505", failure.stderr)
        self.assertEqual(
            self.sql(f"SELECT count(*) FROM users WHERE email = '{email}';").stdout.strip(),
            "1",
        )


    def test_document_identity_is_scoped_by_type_and_jurisdiction(self):
        document = uuid4().hex.upper()
        result = self.sql(f"""
            BEGIN;
            INSERT INTO users(email) VALUES ('{document.lower()}@example.invalid');
            INSERT INTO user_documents
            SELECT id, 'CC', 'CO', '{document}' FROM users
            WHERE email = '{document.lower()}@example.invalid';
            INSERT INTO user_documents
            SELECT id, 'CC', 'EC', '{document}' FROM users
            WHERE email = '{document.lower()}@example.invalid';
            ROLLBACK;
        """)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sku_can_be_reused_by_another_workshop(self):
        identifier = uuid4().hex
        result = self.sql(f"""
            BEGIN;
            INSERT INTO workshops(name, document_id)
            VALUES ('Verification A', '{identifier}-a'), ('Verification B', '{identifier}-b');
            INSERT INTO workshop_products
            SELECT id, 'FILTER-01', 'Filter' FROM workshops
            WHERE document_id IN ('{identifier}-a', '{identifier}-b');
            SELECT count(*) FROM workshop_products WHERE workshop_id IN
              (SELECT id FROM workshops WHERE document_id IN ('{identifier}-a', '{identifier}-b'));
            ROLLBACK;
        """)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), '2')