"""Test settings: the disk cache is off, so tests never read or write cache/data.

(tests/test_cache.py turns it on in a temporary folder to test it.)
"""

import os

os.environ.setdefault("ANVIS_DISK_CACHE_MB", "0")
