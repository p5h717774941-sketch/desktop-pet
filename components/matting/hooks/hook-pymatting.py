# Numba's cache locators require real source paths, not PYZ virtual filenames.
# Collect as source modules so the worker runs without a developer checkout.
module_collection_mode = 'py'
