"""Website announcements must survive release-time changelog regeneration."""
import importlib.util
import pathlib
import tempfile
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('changelog', ROOT / 'scripts/generate-changelog.py')
changelog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changelog)


class WebsiteUpdatesTests(unittest.TestCase):
    def test_regeneration_preserves_announcements_and_rss(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            public = root / 'api/public'
            public.mkdir(parents=True)
            (public / 'docs.html').write_text((ROOT / 'api/public/docs.html').read_text())
            updates = root / 'content/changelog'
            updates.mkdir(parents=True)
            (updates / 'announcement.txt').write_text(
                'title: Tools & workflows\ndate: 2026-11-10\n'
                'url: /blog/example\ndescription: MCP <examples> & safety.\n'
            )
            with patch.object(changelog, 'ROOT', root), patch.object(changelog, 'PUB', public), \
                    patch.object(changelog, 'tags', return_value=['v1.0.0']), \
                    patch.object(changelog, 'sh', return_value='2026-11-01'), \
                    patch.object(changelog, 'commits', return_value=[]):
                changelog.build()
                first = (public / 'changelog.html').read_text()
                feed = ET.parse(public / 'changelog.xml')
                self.assertIn('Tools &amp; workflows', first)
                self.assertIn('href="/blog/example"', first)
                item = feed.find('./channel/item')
                self.assertEqual(item.findtext('title'), 'Tools & workflows')
                self.assertEqual(item.findtext('link'), 'https://omnikeyai.ca/blog/example')
                self.assertEqual(item.findtext('description'), 'MCP <examples> & safety.')
                changelog.build()
                self.assertEqual(first, (public / 'changelog.html').read_text())
                (updates / 'announcement.txt').unlink()
                changelog.build()
                self.assertNotIn('id="website-updates"', (public / 'changelog.html').read_text())
                self.assertEqual(len(ET.parse(public / 'changelog.xml').findall('./channel/item')), 1)


if __name__ == '__main__':
    unittest.main()
