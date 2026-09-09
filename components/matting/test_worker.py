import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerContractTests(unittest.TestCase):
    def test_atomic_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker.progress(root, 'matting', 5)
            self.assertEqual(json.loads((root / 'progress.json').read_text()),
                             dict(stage='matting', current=5, total=24))
            worker.progress(root, 'error', error='测试失败')
            self.assertEqual(json.loads((root / 'progress.json').read_text())['error'], '测试失败')
            self.assertFalse((root / 'progress.tmp').exists())

    def test_model_input_contract_is_fixed(self):
        # Source files are UTF-8; Windows' locale default may be a legacy code page.
        source = Path(__file__).with_name('worker.py').read_text(encoding='utf-8')
        self.assertIn("providers=['CPUExecutionProvider']", source)
        self.assertIn('estimate_alpha_cf(rgb, trimap)', source)
        self.assertIn('estimate_foreground_ml(rgb, alpha)', source)
        self.assertIn("--preserve-props", source)


if __name__ == '__main__':
    unittest.main()
