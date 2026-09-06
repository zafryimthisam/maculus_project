import unittest

from prepare_detector_upgrade import canonical_label, validate_shapes


class DetectorContractTests(unittest.TestCase):
    def test_accepts_legacy_and_broad_raw_outputs(self):
        for count in (80, 365, 601):
            validate_shapes([1, 416, 416, 3], [1, count + 4, 3549], ["object"] * count)

    def test_rejects_wrong_label_pair(self):
        with self.assertRaises(ValueError):
            validate_shapes([1, 416, 416, 3], [1, 605, 3549], ["object"] * 80)

    def test_rejects_end_to_end_or_transposed_outputs(self):
        for shape in ([1, 300, 6], [1, 3549, 605], [1, 605, 0]):
            with self.assertRaises(ValueError):
                validate_shapes([1, 416, 416, 3], shape, ["object"] * 601)

    def test_rejects_unsupported_input_and_blank_labels(self):
        for shape in ([1, 3, 416, 416], [1, 416, 320, 3], [2, 416, 416, 3]):
            with self.assertRaises(ValueError):
                validate_shapes(shape, [1, 84, 3549], ["object"] * 80)
        with self.assertRaises(ValueError):
            validate_shapes([1, 416, 416, 3], [1, 5, 3549], [""])

    def test_preserves_person_reid_and_distinct_furniture(self):
        for label in ("Person", "Man", "Woman", "Boy", "Girl"):
            self.assertEqual(canonical_label(label), "person")
        self.assertEqual(canonical_label("Cupboard"), "cupboard")
        self.assertEqual(canonical_label("Refrigerator"), "refrigerator")
        self.assertEqual(canonical_label("Human face"), "human face")


if __name__ == "__main__":
    unittest.main()
